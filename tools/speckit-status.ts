import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import {
  readSession,
  writeSession,
  readSpecJson,
  exists,
  detectPhase,
  getFeatureDirs,
  resolveProjectRoot,
  getProjectRootWarnings,
  reconstructFromFrontmatter,
  approvalAwareNextStep,
  PHASE_NEXT_STEP,
  SessionState,
  SpecJson,
  constitutionPath,
  specsDirPath,
  sessionPath,
  withLock,
  corruptionWarnings,
  clearCorruptionWarnings,
} from "./shared/types"
import { readRestoreJournal } from "./shared/snapshot/paths"

export default tool({
  description: "Show the current Spec-Driven Development workflow state across all features",
  args: {
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
      const constitutionExists = await exists(constitutionPath(projectRoot))
      const dirs = await getFeatureDirs(projectRoot)
      const featurePhases: { dir: string; phase: SessionState["phase"] }[] = []
      const phaseCounts: Record<string, number> = {}
      let latest: string | null = null
      let latestPhase: SessionState["phase"] | "none" | "unknown" = "none"
      let latestSj: SpecJson | null = null
      let computedNext = "/spec <description>"
      let summary = "No features yet."

      await withLock(sessionPath(projectRoot), async () => {
        const session = await readSession(projectRoot)
        latest = session.featureDir && dirs.includes(session.featureDir)
          ? session.featureDir
          : dirs.length > 0 ? dirs[dirs.length - 1] : null

        for (const dir of dirs) {
          const base = path.join(specsDirPath(projectRoot), dir)
          let sj = await readSpecJson(base)
          const [specOk, planOk, tasksOk] = await Promise.all([
            exists(path.join(base, "spec.md")),
            exists(path.join(base, "plan.md")),
            exists(path.join(base, "tasks.md")),
          ])

          if (!sj) {
            sj = await reconstructFromFrontmatter(base)
          }
          if (dir === latest) {
            latestSj = sj
          }

          let phase: SessionState["phase"]
          if (sj) {
            phase = sj.phase
          } else {
            ;({ phase } = detectPhase(specOk, planOk, tasksOk, constitutionExists))
          }
          featurePhases.push({ dir, phase })
          phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1
        }

        latestPhase = latest
          ? (featurePhases.find(f => f.dir === latest)?.phase ?? "unknown")
          : "none"
        summary = dirs.length === 0
          ? "No features yet."
          : `Features: ${dirs.length} | ` + Object.entries(phaseCounts)
              .map(([p, c]) => `${p}: ${c}`)
              .join(", ")

        session.command = "/status"
        if (latestPhase !== "none" && latestPhase !== "unknown") {
          session.phase = latestPhase
        }
        session.featureDir = latest
        computedNext = approvalAwareNextStep(
          latestSj,
          PHASE_NEXT_STEP[latestPhase] ?? "/spec <description>",
        )
        session.nextStep = computedNext
        session.lastResult = summary
        session.history.push("/status")
        if (session.history.length > 20) session.history = session.history.slice(-20)
        await writeSession(projectRoot, session)
      })

      const corruptionLines = corruptionWarnings.map(w => `[CORRUPTION] ${w.file}: ${w.message}`)
      clearCorruptionWarnings()

      const journal = await readRestoreJournal(projectRoot)
      const journalPart = journal ? "\n[INTERRUPTED RESTORE] pending — run /snapshot recover" : ""

      const dashboard = featurePhases.map(f => `${f.dir} (${f.phase})`).join("  ")
      const corruptionPart = corruptionLines.length > 0 ? "\n" + corruptionLines.join("\n") : ""
      const line = dirs.length === 0
        ? "No features yet. Next: /spec <description>" + corruptionPart + journalPart
        : `${summary}  ${dashboard}  Next: ${computedNext}${corruptionPart}${journalPart}`

      return {
        title: `Status: ${dirs.length} feature(s)` + (corruptionLines.length > 0 ? " [corruption detected]" : ""),
        output: line,
        metadata: {
          phase: latestPhase,
          featureCount: dirs.length,
          features: featurePhases.map(f => ({ dir: f.dir, phase: f.phase })),
          latestFeature: latest,
          constitutionExists,
          phaseCounts,
          nextCommand: computedNext,
          interruptedRestore: journal !== null,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `status: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
