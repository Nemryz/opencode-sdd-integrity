import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import {
  readSpecJson,
  writeSpecJson,
  exists,
  getFeatureDirs,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  reconstructFromFrontmatter,
  syncFrontmatterFromSpecJson,
  constitutionPath,
  specsDirPath,
  steeringDirPath,
  specJsonPath,
  PATHS,
  phaseFromArtifacts,
  withLock,
  corruptionWarnings,
  clearCorruptionWarnings,
  collectTaskIds,
  withStateLock,
} from "./shared/types"
import { DeltasIndexSchema, EvidenceFileSchema, type Delta, type EvidenceFile } from "./shared/schemas"
import { computeBodyChecksum, stripBom } from "./shared/io"
import { postFailureNote, snapshotAfterFailure, snapshotBeforeOperation } from "./shared/snapshot/triggers"

export interface AuditFinding {
  severity: "info" | "warn" | "error"
  category: string
  message: string
  file?: string
  artifact?: "spec" | "plan" | "tasks"
}

interface AuditReport {
  passed: boolean
  findings: AuditFinding[]
  summary: { info: number; warn: number; error: number }
}

async function auditFeature(
  projectRoot: string,
  dirName: string,
  findings: AuditFinding[],
): Promise<void> {
  const base = path.join(specsDirPath(projectRoot), dirName)
  const specOk = await exists(path.join(base, "spec.md"))
  const planOk = await exists(path.join(base, "plan.md"))
  const tasksOk = await exists(path.join(base, "tasks.md"))
  const dataModelOk = await exists(path.join(base, "data-model.md"))
  const researchOk = await exists(path.join(base, "research.md"))
  const contractsOk = await exists(path.join(base, "contracts"))

  let sj = await readSpecJson(base)

  if (!sj) {
    const sjFromFm = await reconstructFromFrontmatter(base)
    if (sjFromFm) {
      findings.push({
        severity: "info",
        category: "frontmatter-recovery",
        message: `${dirName}: spec.json missing, recovered from frontmatter (phase=${sjFromFm.phase})`,
        file: path.join(base, "spec.json"),
      })
      sj = sjFromFm
    } else {
      findings.push({
        severity: "warn",
        category: "spec-json",
        message: `No spec.json found for ${dirName}`,
        file: path.join(base, "spec.json"),
      })
      return
    }
  }

  if (sj.phase !== "complete" && sj.phase !== "impl") {
    if (sj.phase === "ready" && !(specOk && planOk && tasksOk)) {
      findings.push({
        severity: "error",
        category: "phase-mismatch",
        message: `${dirName}: spec.json says ready but files missing (spec=${specOk}, plan=${planOk}, tasks=${tasksOk})`,
        file: path.join(base, "spec.json"),
      })
    } else if (sj.phase === "tasks" && !tasksOk) {
      findings.push({
        severity: "error",
        category: "phase-mismatch",
        message: `${dirName}: spec.json says tasks but tasks.md missing`,
        file: path.join(base, "spec.json"),
      })
    } else if (sj.phase === "plan" && !planOk) {
      findings.push({
        severity: "error",
        category: "phase-mismatch",
        message: `${dirName}: spec.json says plan but plan.md missing`,
        file: path.join(base, "spec.json"),
      })
    } else if (sj.phase === "spec" && !specOk) {
      findings.push({
        severity: "error",
        category: "phase-mismatch",
        message: `${dirName}: spec.json says spec but spec.md missing`,
        file: path.join(base, "spec.json"),
      })
    }
  }

  if (!sj.approvals.spec.generated && specOk) {
    findings.push({
      severity: "info",
      category: "approval",
      artifact: "spec",
      message: `${dirName}: spec.md exists but spec approval not marked generated`,
      file: path.join(base, "spec.json"),
    })
  }
  if (!sj.approvals.plan.generated && planOk) {
    findings.push({
      severity: "info",
      category: "approval",
      artifact: "plan",
      message: `${dirName}: plan.md exists but plan approval not marked generated`,
      file: path.join(base, "spec.json"),
    })
  }
  if (!sj.approvals.tasks.generated && tasksOk) {
    findings.push({
      severity: "info",
      category: "approval",
      artifact: "tasks",
      message: `${dirName}: tasks.md exists but tasks approval not marked generated`,
      file: path.join(base, "spec.json"),
    })
  }

  if (sj.approvals.spec.approved && !sj.approvals.plan.generated && planOk) {
    findings.push({
      severity: "warn",
      category: "approval-order",
      message: `${dirName}: spec approved but plan not transitioned to generated`,
      file: path.join(base, "spec.json"),
    })
  }

  const artifactFiles: Record<string, string> = { spec: "spec.md", plan: "plan.md", tasks: "tasks.md" }
  for (const artifact of ["spec", "plan", "tasks"] as const) {
    const state = sj.approvals[artifact]
    if (!state.approved || !state.hash) continue
    const artifactPath = path.join(base, artifactFiles[artifact])
    try {
      const content = await fs.readFile(artifactPath, "utf-8")
      if (computeBodyChecksum(content) !== state.hash) {
        findings.push({
          severity: "warn",
          category: "approval-drift",
          artifact,
          message: `${dirName}: ${artifactFiles[artifact]} was modified after approval — re-run /approve ${artifact}`,
          file: artifactPath,
        })
      }
    } catch {
      // missing artifact files are reported by other checks
    }
  }

  if (sj.ready_for_implementation && !(specOk && planOk && tasksOk)) {
    findings.push({
      severity: "error",
      category: "ready-violation",
      message: `${dirName}: marked ready_for_implementation but artifacts incomplete`,
      file: path.join(base, "spec.json"),
    })
  }

  if (specOk) {
    const specContent = await fs.readFile(path.join(base, "spec.md"), "utf-8").catch(() => "")
    if (specContent.includes("[NEEDS CLARIFICATION]")) {
      findings.push({
        severity: "warn",
        category: "spec-clarity",
        message: `${dirName}: spec.md contains unresolved [NEEDS CLARIFICATION] markers`,
        file: path.join(base, "spec.md"),
      })
    }
  }

  if (tasksOk) {
    const tasksContent = await fs.readFile(path.join(base, "tasks.md"), "utf-8").catch(() => "")
    const lines = tasksContent.split("\n")
    const hasBoundary = lines.some(l => /Boundary\*{0,2}:/.test(l))
    if (!hasBoundary) {
      findings.push({
        severity: "info",
        category: "tasks-boundary",
        message: `${dirName}: tasks.md has no Boundary annotations`,
        file: path.join(base, "tasks.md"),
      })
    }

    // Evidence only matters once implementation started, so earlier phases stay quiet.
    if (sj.phase === "impl" || sj.phase === "complete") {
      const evidenceFp = path.join(base, "evidence.json")
      const evidenceExists = await exists(evidenceFp)
      if (!evidenceExists) {
        findings.push({
          severity: "warn",
          category: "evidence-missing",
          message: `${dirName}: ${sj.phase} phase has no test evidence recorded`,
          file: evidenceFp,
        })
      } else {
        let file: EvidenceFile | null = null
        try {
          const raw = await fs.readFile(evidenceFp, "utf-8")
          const result = EvidenceFileSchema.safeParse(JSON.parse(stripBom(raw)))
          if (result.success) file = result.data
        } catch {
          // a file that cannot be parsed is reported as corrupt below
        }
        if (file === null) {
          findings.push({
            severity: "warn",
            category: "evidence-corrupt",
            message: `${dirName}: evidence.json is corrupt`,
            file: evidenceFp,
          })
        } else {
          const taskIds = collectTaskIds(tasksContent)
          const taskSet = new Set(taskIds)
          const missing: string[] = []
          for (const id of taskIds) {
            const own = file.entries.filter(e => e.task === id)
            if (own.length === 0) {
              missing.push(id)
              continue
            }
            const last = own[own.length - 1]
            if (last.exit_code !== 0) {
              findings.push({
                severity: "warn",
                category: "evidence-failing",
                message: `${dirName}: latest evidence for ${id} is a failing run (${last.test_command}, exit ${last.exit_code})`,
                file: evidenceFp,
              })
            }
          }
          if (missing.length > 0) {
            const shown = missing.slice(0, 5).join(", ")
            const suffix = missing.length > 5 ? " and more" : ""
            findings.push({
              severity: "info",
              category: "evidence-gap",
              message: `${dirName}: ${missing.length} ${missing.length === 1 ? "task has" : "tasks have"} no test evidence (${shown}${suffix})`,
              file: evidenceFp,
            })
          }
          const featureEntries = file.entries.filter(e => !taskSet.has(e.task))
          const lastFeature = featureEntries[featureEntries.length - 1]
          if (lastFeature && lastFeature.exit_code !== 0) {
            findings.push({
              severity: "warn",
              category: "evidence-failing",
              message: `${dirName}: latest feature-level evidence is a failing run (${lastFeature.test_command}, exit ${lastFeature.exit_code})`,
              file: evidenceFp,
            })
          }
        }
      }
    }
  }

  if (researchOk) {
    findings.push({
      severity: "info",
      category: "optional-artifact",
      message: `${dirName}: has research.md`,
      file: path.join(base, "research.md"),
    })
  }
  if (dataModelOk) {
    findings.push({
      severity: "info",
      category: "optional-artifact",
      message: `${dirName}: has data-model.md`,
      file: path.join(base, "data-model.md"),
    })
  }
  if (contractsOk) {
    findings.push({
      severity: "info",
      category: "optional-artifact",
      message: `${dirName}: has contracts/ directory`,
      file: path.join(base, "contracts"),
    })
  }

  // Delta audit
  const deltasDir = path.join(base, "deltas")
  const deltasIndexFp = path.join(deltasDir, "deltas.json")
  if (await exists(deltasIndexFp)) {
    try {
      const raw = await fs.readFile(deltasIndexFp, "utf-8")
      const parsed = JSON.parse(stripBom(raw))
      const result = DeltasIndexSchema.safeParse(parsed)
      if (result.success) {
        const activeDeltas = result.data.deltas.filter(d => d.status !== "consolidated" && d.status !== "cancelled")
        const staleDeltas = activeDeltas.filter(d => {
          const age = Date.now() - new Date(d.updated_at).getTime()
          return age > 7 * 24 * 60 * 60 * 1000
        })
        if (activeDeltas.length > 5) {
          findings.push({
            severity: "warn",
            category: "delta-sprawl",
            message: `${dirName}: ${activeDeltas.length} active deltas (consider consolidating)`,
            file: deltasIndexFp,
          })
        }
        for (const delta of staleDeltas) {
          findings.push({
            severity: "info",
            category: "stale-delta",
            message: `${dirName}: delta ${delta.id} has been ${delta.status} for > 7 days`,
            file: deltasIndexFp,
          })
        }
      }
    } catch { /* ignore */ }
  }
}

async function auditProject(projectRoot: string): Promise<AuditReport> {
  const findings: AuditFinding[] = []

  const constitutionExists = await exists(constitutionPath(projectRoot))
  if (!constitutionExists) {
    findings.push({
      severity: "warn",
      category: "constitution",
      message: "Constitution file missing in .opencode/spec-memory/",
      file: constitutionPath(projectRoot),
    })
  } else {
    findings.push({
      severity: "info",
      category: "constitution",
      message: "Constitution file present",
      file: constitutionPath(projectRoot),
    })
  }

  const steeringDir = steeringDirPath(projectRoot)
  const steeringExists = await exists(steeringDir)
  if (steeringExists) {
    const entries = await fs.readdir(steeringDir).catch(() => [])
    if (entries.length === 0) {
      findings.push({
        severity: "warn",
        category: "steering",
        message: "Steering directory exists but is empty",
        file: steeringDir,
      })
    } else {
      const productOk = await exists(path.join(steeringDir, PATHS.PRODUCT_STEERING_FILE))
      const techOk = await exists(path.join(steeringDir, PATHS.TECH_STEERING_FILE))
      const structureOk = await exists(path.join(steeringDir, PATHS.STRUCTURE_STEERING_FILE))
      if (!productOk) {
        findings.push({ severity: "info", category: "steering", message: "Steering missing product.md", file: steeringDir })
      }
      if (!techOk) {
        findings.push({ severity: "info", category: "steering", message: "Steering missing tech.md", file: steeringDir })
      }
      if (!structureOk) {
        findings.push({ severity: "info", category: "steering", message: "Steering missing structure.md", file: steeringDir })
      }
      if (productOk && techOk && structureOk) {
        findings.push({ severity: "info", category: "steering", message: "Full steering context present" })
      }
    }
  } else {
    findings.push({ severity: "info", category: "steering", message: "No steering directory (optional)" })
  }

  const guardPath = path.join(projectRoot, ".opencode", "guard.json")
  try {
    const raw = await fs.readFile(guardPath, "utf-8")
    const guard = JSON.parse(stripBom(raw)) as { debug?: unknown }
    if (guard.debug === true) {
      findings.push({
        severity: "info",
        category: "guard-debug",
        message: "Guard debug mode is enabled — disable it with /guard debug off",
        file: guardPath,
      })
    }
  } catch {
    // missing or unreadable guard.json is not an audit failure
  }

  const featureDirs = await getFeatureDirs(projectRoot)
  if (featureDirs.length === 0) {
    findings.push({
      severity: "info",
      category: "features",
      message: "No feature directories found",
    })
  } else {
    findings.push({
      severity: "info",
      category: "features",
      message: `${featureDirs.length} feature(s) found: ${featureDirs.join(", ")}`,
    })
    for (const dir of featureDirs) {
      await auditFeature(projectRoot, dir, findings)
    }
  }

  // Collect corruption warnings last so warnings pushed while auditing features
  // (e.g. corrupt spec.json read during auditFeature) are included in this report
  for (const w of corruptionWarnings) {
    findings.push({
      severity: "warn",
      category: "corruption",
      message: `${w.file}: ${w.message}`,
      file: w.file,
    })
  }
  clearCorruptionWarnings()

  const summary = { info: 0, warn: 0, error: 0 }
  for (const f of findings) {
    summary[f.severity]++
  }

  const passed = summary.error === 0

  return { passed, findings, summary }
}

export default tool({
  description: "Run a comprehensive audit of the project for phase consistency, artifact health, and configuration issues",
  args: {
    fix: tool.schema.boolean().optional().describe("Attempt auto-fix for detected issues"),
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

      const report = await auditProject(projectRoot)

      let fixBlockedNote = ""
      let fixAllowed = true
      if (args.fix && report.findings.length > 0) {
        const recovery = await snapshotBeforeOperation(projectRoot, "pre-fix:audit")
        if (!recovery.ok) {
          fixAllowed = false
          fixBlockedNote = `Fix blocked: pre-fix snapshot failed (${recovery.error ?? "unknown error"}). No changes applied.`
        }
      }

      if (args.fix && fixAllowed && report.findings.length > 0) {
        try {
          let fixedCount = 0
          let fixedErrorCount = 0
          const fixedBases: string[] = []
          for (const finding of report.findings) {
            if (finding.severity === "error" && finding.category === "phase-mismatch") {
              const sjPath = finding.file
              if (sjPath && sjPath.endsWith("spec.json")) {
                const base = path.dirname(sjPath)
                const specOk = await exists(path.join(base, "spec.md"))
                const planOk = await exists(path.join(base, "plan.md"))
                const tasksOk = await exists(path.join(base, "tasks.md"))
                await withStateLock(projectRoot, () => withLock(specJsonPath(base), async () => {
                  const sjPrev = await readSpecJson(base)
                  const newPhase = sjPrev
                    ? phaseFromArtifacts(specOk, planOk, tasksOk, sjPrev.approvals.tasks.approved)
                    : null
                  if (sjPrev && newPhase && sjPrev.phase !== newPhase) {
                    sjPrev.phase = newPhase
                    await writeSpecJson(sjPrev, base)
                    await syncFrontmatterFromSpecJson(base, sjPrev)
                    fixedBases.push(base)
                    finding.message += " (auto-fixed)"
                    fixedCount++
                    fixedErrorCount++
                  }
                }))
              }
            } else if (finding.severity === "error" && finding.category === "ready-violation") {
              const sjPath = finding.file
              if (sjPath && sjPath.endsWith("spec.json")) {
                const base = path.dirname(sjPath)
                await withStateLock(projectRoot, () => withLock(specJsonPath(base), async () => {
                  const sjPrev = await readSpecJson(base)
                  if (sjPrev && sjPrev.ready_for_implementation) {
                    sjPrev.ready_for_implementation = false
                    await writeSpecJson(sjPrev, base)
                    await syncFrontmatterFromSpecJson(base, sjPrev)
                    fixedBases.push(base)
                    finding.message += " (auto-fixed)"
                    fixedCount++
                    fixedErrorCount++
                  }
                }))
              }
            } else if (finding.severity === "info" && finding.category === "approval") {
              const sjPath = finding.file
              if (sjPath && sjPath.endsWith("spec.json")) {
                const base = path.dirname(sjPath)
                await withStateLock(projectRoot, () => withLock(specJsonPath(base), async () => {
                  const sjPrev = await readSpecJson(base)
                  if (sjPrev) {
                    let changed = false
                    if (!sjPrev.approvals.spec.generated && finding.artifact === "spec") {
                      sjPrev.approvals.spec.generated = true
                      changed = true
                    }
                    if (!sjPrev.approvals.plan.generated && finding.artifact === "plan") {
                      sjPrev.approvals.plan.generated = true
                      changed = true
                    }
                    if (!sjPrev.approvals.tasks.generated && finding.artifact === "tasks") {
                      sjPrev.approvals.tasks.generated = true
                      changed = true
                    }
                    if (changed) {
                      await writeSpecJson(sjPrev, base)
                      await syncFrontmatterFromSpecJson(base, sjPrev)
                      fixedBases.push(base)
                      finding.message += " (auto-fixed)"
                      fixedCount++
                    }
                  }
                }))
              }
            }
          }
          if (fixedCount > 0) {
            const auditMeta: import("./shared/schemas").AuditMetadata = {
              date: new Date().toISOString(),
              findings: fixedCount,
              severity: report.summary.error > 0 ? "high" : report.summary.warn > 0 ? "medium" : "low",
            }
            for (const base of fixedBases) {
              const sj = await readSpecJson(base)
              if (sj) await syncFrontmatterFromSpecJson(base, sj, { last_audit: auditMeta })
            }
            report.summary.error -= fixedErrorCount
            if (report.summary.error < 0) report.summary.error = 0
            report.passed = report.summary.error === 0
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const failure = await snapshotAfterFailure(projectRoot, "post-failure:audit")
          const note = postFailureNote(failure)
          fixBlockedNote = `Fix failed: ${message}.${note}`
        }
      }

      const lines: string[] = []
      for (const f of report.findings) {
        const tag = f.severity === "error" ? "ERR" : f.severity === "warn" ? "WRN" : "INF"
        lines.push(`[${tag}] ${f.category}: ${f.message}`)
      }
      if (fixBlockedNote) lines.push(fixBlockedNote)

      const status = report.passed ? "PASS" : "FAIL"
      const output = lines.length === 0
        ? `Audit: ${status} | No findings`
        : `Audit: ${status} | ${report.summary.error} error(s), ${report.summary.warn} warning(s), ${report.summary.info} info\n` + lines.join("\n")

      return {
        title: `Audit: ${report.summary.error + report.summary.warn} issue(s)`,
        output,
        metadata: {
          passed: report.passed,
          errorCount: report.summary.error,
          warnCount: report.summary.warn,
          infoCount: report.summary.info,
          findings: report.findings,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `audit: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
