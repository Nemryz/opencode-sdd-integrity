import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import {
  readSession,
  writeSession,
  readSpecJson,
  writeSpecJson,
  exists,
  parseNNN,
  phaseFromArtifacts,
  getFeatureDirs,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  reconstructFromFrontmatter,
  syncFrontmatterFromSpecJson,
  approvalAwareNextStep,
  PHASE_NEXT_STEP,
  constitutionPath,
  specsDirPath,
  specJsonPath,
  sessionPath,
  withLock,
  SpecJsonSchema,
  corruptionWarnings,
  clearCorruptionWarnings,
  stripBom,
} from "./shared/types"
import { postFailureNote, snapshotAfterFailure, snapshotBeforeOperation } from "./shared/snapshot/triggers"

export default tool({
  description: "Scan all feature directories and report inconsistencies in artifact states",
  args: {
    fix: tool.schema.boolean().optional().describe("Auto-fix session.json to match reality (does not create/delete artifacts)"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the project-root warning"),
  },
  async execute(args, context) {
    try {
      const resolved = await resolveProjectRoot(context)
      if (!resolved.root) return { title: "Error", output: resolved.error ?? "Not a valid project directory" }
      const projectRoot = resolved.root
      const projectWarnings = await getProjectRootWarnings(projectRoot)
      if (projectWarnings.length > 0 && !args.confirmed) {
        return {
          title: "Warning",
          output: `${projectWarnings.map(w => w.message).join("\n\n")}\n\nAsk the user to confirm, then re-run with confirmed: true.`,
          metadata: { warnings: projectWarnings, requiresConfirmation: true },
        }
      }
      const parentProject = await detectParentProjectWithoutSession(projectRoot)
      if (parentProject) {
        return {
          title: "Warning",
          output: `Parent project detected at ${parentProject} without session. Do you want to continue?`,
          metadata: { parentProject, requiresConfirmation: true },
        }
      }
      const specsDir = specsDirPath(projectRoot)
      let entries: string[] = []
      try {
        entries = (await fs.readdir(specsDir, { withFileTypes: true }))
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .filter(n => parseNNN(n) > 0)
          .sort((a, b) => parseNNN(a) - parseNNN(b))
      } catch {
        return {
          title: "No features",
          output: "No feature directories found in specs/",
          metadata: { features: [], issues: [] },
        }
      }

      interface FeatureReport {
        dir: string
        nnn: number
        spec: boolean
        plan: boolean
        tasks: boolean
        status: "ok" | "incomplete" | "orphan"
      }

      const reports: FeatureReport[] = []
      const issues: string[] = []
      let specJsonMismatches = 0
      let deltaWarnings = 0

        for (const dir of entries) {
          const base = path.join(specsDir, dir)
          const specOk = await exists(path.join(base, "spec.md"))
          const planOk = await exists(path.join(base, "plan.md"))
          const tasksOk = await exists(path.join(base, "tasks.md"))
          let sj = await readSpecJson(base)

          if (!sj) {
            sj = await reconstructFromFrontmatter(base)
          }

          // Check for stale deltas
          const deltasIndexFp = path.join(base, "deltas", "deltas.json")
          if (await exists(deltasIndexFp)) {
            try {
              const raw = await fs.readFile(deltasIndexFp, "utf-8")
              const parsed = JSON.parse(stripBom(raw))
              const result = (await import("./shared/schemas")).DeltasIndexSchema.safeParse(parsed)
              if (result.success) {
                const cancelled = result.data.deltas.filter(d => d.status === "cancelled")
                if (cancelled.length > 0) {
                  deltaWarnings++
                  issues.push(`${dir}: ${cancelled.length} cancelled delta(s)`)
                }
              }
            } catch { /* ignore */ }
          }

          let status: "ok" | "incomplete" | "orphan"
          if (specOk && planOk && tasksOk) {
            status = "ok"
          } else if (!specOk && !planOk && !tasksOk) {
            status = "orphan"
          } else {
            status = "incomplete"
          }

          const report: FeatureReport = {
            dir,
            nnn: parseNNN(dir),
            spec: specOk,
            plan: planOk,
            tasks: tasksOk,
            status,
          }
          reports.push(report)

          if (status === "incomplete") {
            const missing: string[] = []
            if (!specOk) missing.push("spec")
            if (!planOk) missing.push("plan")
            if (!tasksOk) missing.push("tasks")
            if (missing.length > 0) {
              issues.push(`${dir}: missing ${missing.join(", ")}`)
            }
          } else if (status === "orphan") {
            issues.push(`${dir}: empty directory (no artifacts)`)
          }

          if (sj) {
            const expectedPhase = phaseFromArtifacts(specOk, planOk, tasksOk, sj.approvals.tasks.approved)
            const keepsImplOrComplete = (sj.phase === "impl" || sj.phase === "complete") && specOk && planOk && tasksOk
            if (sj.phase !== expectedPhase && !keepsImplOrComplete) {
              issues.push(`${dir}: spec.json phase "${sj.phase}" ≠ reality "${expectedPhase}"`)
              specJsonMismatches++
            }
            if (sj.ready_for_implementation && !(specOk && planOk && tasksOk)) {
              issues.push(`${dir}: marked ready_for_implementation but files show phase "${expectedPhase}"`)
            }
          }
        }

      let fixBlockedNote = ""
      if (args.fix) {
        // ── Phase 1: Collect spec.json changes ──
        interface PendingSpecChange {
          base: string
          dir: string
          sj: import("./shared/types").SpecJson
        }
        const specChanges: PendingSpecChange[] = []

        for (const dir of entries) {
          const report = reports.find(r => r.dir === dir)
          if (!report) continue
          const base = path.join(specsDir, dir)
          const sj = await readSpecJson(base)
          if (!sj) continue
          const expectedPhase = phaseFromArtifacts(report.spec, report.plan, report.tasks, sj.approvals.tasks.approved)
          const keepsImplOrComplete = (sj.phase === "impl" || sj.phase === "complete") && report.spec && report.plan && report.tasks
          let changed = false
          if (sj.phase !== expectedPhase && !keepsImplOrComplete) {
            sj.phase = expectedPhase
            changed = true
          }
          const correctRfi = report.spec && report.plan && report.tasks && sj.approvals.tasks.approved
          if (sj.ready_for_implementation !== correctRfi) {
            sj.ready_for_implementation = correctRfi
            changed = true
          }
          if (changed) {
            specChanges.push({ base, dir, sj })
          }
        }

        // ── Phase 2: Validate all spec.json changes ──
        for (const change of specChanges) {
          const result = SpecJsonSchema.safeParse(change.sj)
          if (!result.success) {
            throw new Error(`/clean --fix: validation failed for ${change.dir}: ${String(result.error)}`)
          }
        }

        // ── Phase 3: Apply all spec.json changes ──
        if (specChanges.length > 0) {
          const recovery = await snapshotBeforeOperation(projectRoot, "pre-fix:clean")
          if (!recovery.ok) {
            fixBlockedNote = `Fix blocked: pre-fix snapshot failed (${recovery.error ?? "unknown error"}). No repairs applied.`
          } else {
            try {
              for (const change of specChanges) {
                await writeSpecJson(change.sj, change.base)
                await syncFrontmatterFromSpecJson(change.base, change.sj)
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const failure = await snapshotAfterFailure(projectRoot, "post-failure:clean")
              fixBlockedNote = `Fix failed: ${message}.${postFailureNote(failure)}`
            }
          }
        }

        // ── Phase 4: Collect session.json changes ──
        interface PendingSessionChange {
          field: string
          apply: (s: import("./shared/types").SessionState) => void
        }
        const sessionChanges: PendingSessionChange[] = []

        // Records every repaired spec.json so the fix run leaves its trace in the session history.
        for (const change of specChanges) {
          sessionChanges.push({
            field: `${change.dir}: phase → ${change.sj.phase}`,
            apply: () => {},
          })
        }

        const s = await readSession(projectRoot)

        if (s.featureDir) {
          const stillExists = reports.some(r => r.dir === s.featureDir)
          if (!stillExists) {
            const newDir = reports.length > 0 ? reports[reports.length - 1].dir : null
            sessionChanges.push({
              field: "featureDir",
              apply: (sess) => {
                sess.featureDir = newDir
                sess.featureNumber = newDir ? parseNNN(newDir) : null
                sess.featureName = null
              },
            })
          }
        } else if (reports.length > 0) {
          const newDir = reports[reports.length - 1].dir
          sessionChanges.push({
            field: "featureDir (assigned)",
            apply: (sess) => {
              sess.featureDir = newDir
              sess.featureNumber = parseNNN(newDir)
            },
          })
        }

        if (s.featureNumber != null && s.featureDir) {
          const expected = parseNNN(s.featureDir)
          if (s.featureNumber !== expected) {
            sessionChanges.push({
              field: "featureNumber",
              apply: (sess) => { sess.featureNumber = expected },
            })
          }
        }

        if (s.featureDir) {
          const report = reports.find(r => r.dir === s.featureDir)
          if (report) {
            const constitutionExists = await exists(constitutionPath(projectRoot))
            const liveSj = await readSpecJson(path.join(specsDir, s.featureDir))
            // A project without its constitution starts at init, otherwise the session mirrors the authoritative spec.json phase.
            const targetPhase = constitutionExists ? liveSj?.phase : "init"
            if (targetPhase && s.phase !== targetPhase) {
              const phase = targetPhase
              const nextStep = phase === "init"
                ? PHASE_NEXT_STEP.init
                : approvalAwareNextStep(liveSj, PHASE_NEXT_STEP[phase] ?? "/review")
              sessionChanges.push({
                field: "session phase",
                apply: (sess) => {
                  sess.phase = phase
                  sess.nextStep = nextStep
                },
              })
            }
          }
        }

        // ── Phase 5: Apply session.json changes ──
        if (sessionChanges.length > 0 && !fixBlockedNote) {
          if (specChanges.length === 0) {
            const recovery = await snapshotBeforeOperation(projectRoot, "pre-fix:clean")
            if (!recovery.ok) {
              fixBlockedNote = `Fix blocked: pre-fix snapshot failed (${recovery.error ?? "unknown error"}). No repairs applied.`
            }
          }
          if (!fixBlockedNote) {
            try {
              s.lastResult = "repaired: " + sessionChanges.map(c => c.field).join(", ")
              s.history.push("/clean")
              await withLock(sessionPath(projectRoot), async () => {
                const liveS = await readSession(projectRoot)
                for (const change of sessionChanges) {
                  change.apply(liveS)
                }
                liveS.lastResult = "repaired: " + sessionChanges.map(c => c.field).join(", ")
                liveS.history.push("/clean")
                await writeSession(projectRoot, liveS)
              })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const failure = await snapshotAfterFailure(projectRoot, "post-failure:clean")
              fixBlockedNote = `Fix failed: ${message}.${postFailureNote(failure)}`
            }
          }
        }
      }

      if (fixBlockedNote) issues.push(fixBlockedNote)

      for (const w of corruptionWarnings) {
        issues.push(`[corruption] ${w.file}: ${w.message}`)
      }
      clearCorruptionWarnings()

      const summary = issues.length === 0
        ? "All features consistent"
        : `${issues.length} issue(s) detected`

      const okCount = reports.filter(r => r.status === "ok").length
      const incompleteCount = reports.filter(r => r.status === "incomplete").length
      const orphanCount = reports.filter(r => r.status === "orphan").length

      return {
        title: `Clean: ${reports.length} features, ${issues.length} issues`,
        output: `${summary}  Next: /status`,
        metadata: {
          total: reports.length,
          ok: okCount,
          incomplete: incompleteCount,
          orphan: orphanCount,
          specJsonMismatches,
          issues,
          reports: reports.map(r => ({
            dir: r.dir,
            status: r.status,
            artifacts: { spec: r.spec, plan: r.plan, tasks: r.tasks },
          })),
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `clean: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
