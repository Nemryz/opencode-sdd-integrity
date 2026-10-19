import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import {
  readSession,
  writeSession,
  readSpecJson,
  exists,
  detectPhase,
  getLatestFeatureDir,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  reconstructFromFrontmatter,
  approvalAwareNextStep,
  SpecJson,
  SessionState,
  PHASE_NEXT_STEP,
  constitutionPath,
  specsDirPath,
  specJsonPath,
  sessionPath,
  withLock,
  clearCorruptionWarnings,
  isSafeFeatureDirName,
} from "./shared/types"

export default tool({
  description: "Validate that required SDD artifacts exist and determine current workflow phase",
  args: {
    featureDir: tool.schema.string().optional().describe("Specific feature directory to validate (defaults to latest)"),
    command: tool.schema.string().optional().describe("Command name that triggered this validation (e.g., plan, tasks, impl)"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the project-root warning"),
  },
  async execute(args, context) {
    clearCorruptionWarnings()
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
      // Mirrors the delta guard so a path shaped name never becomes the session feature reference.
      if (args.featureDir !== undefined && !isSafeFeatureDirName(args.featureDir)) {
        return { title: "Error", output: `Invalid featureDir: ${args.featureDir}` }
      }
      const toolResult = await withLock(sessionPath(projectRoot), async () => {
        const s = await readSession(projectRoot)
        const featureDir = args.featureDir ?? s.featureDir ?? (await getLatestFeatureDir(projectRoot))
        const constitutionExists = await exists(constitutionPath(projectRoot))

        let specOk = false
        let planOk = false
        let tasksOk = false
        let specJson: SpecJson | null = null
        let specJsonPhase: SessionState["phase"] | null = null
        let mismatch = false
        let specJsonCorrupted = false

        if (featureDir) {
          const base = path.join(specsDirPath(projectRoot), featureDir)
          specOk = await exists(path.join(base, "spec.md"))
          planOk = await exists(path.join(base, "plan.md"))
          tasksOk = await exists(path.join(base, "tasks.md"))
          const specJsonFile = specJsonPath(base)
          const specJsonExists = await exists(specJsonFile)
          specJson = await readSpecJson(base)
          if (!specJson && !specJsonExists) {
            specJson = await reconstructFromFrontmatter(base)
            if (specJson) {
              specJsonPhase = specJson.phase
            }
          } else if (specJson) {
            specJsonPhase = specJson.phase
            const filesOk = specOk && planOk && tasksOk
            if (specJson.phase === "ready" && !filesOk) {
              mismatch = true
            } else if (specJson.phase === "spec" && (!specOk || planOk || tasksOk)) {
              mismatch = true
            } else if (specJson.phase === "plan" && !planOk) {
              mismatch = true
            } else if (specJson.phase === "tasks" && !tasksOk) {
              mismatch = true
            } else if ((specJson.phase === "impl" || specJson.phase === "complete") && !filesOk) {
              mismatch = true
            }
          } else if (specJsonExists) {
            specJsonCorrupted = true
          }
        }

        const parts: string[] = []
        if (!constitutionExists) parts.push("constitution missing")
        if (featureDir) {
          if (specJsonPhase) {
            parts.push(`spec.json phase: ${specJsonPhase}`)
          }
          parts.push(specOk ? "spec ok" : "spec missing")
          parts.push(planOk ? "plan ok" : "plan missing")
          parts.push(tasksOk ? "tasks ok" : "tasks missing")
          if (specJsonCorrupted) {
            parts.push("WARN: spec.json corrupted")
          }
          if (mismatch) {
            parts.push("WARN: spec.json phase ≠ reality")
          }
        } else {
          parts.push("no features")
        }

        let phase: SessionState["phase"] | "empty", nextStep: string
        if (!featureDir) {
          phase = "empty"
          nextStep = constitutionExists ? "/spec <description>" : "create constitution.md first"
        } else if (specJsonPhase && !mismatch) {
          phase = specJsonPhase
          nextStep = approvalAwareNextStep(specJson, PHASE_NEXT_STEP[phase] ?? "/review")
        } else {
          ;({ phase, nextStep } = detectPhase(specOk, planOk, tasksOk, constitutionExists))
        }

        s.command = args.command ? "/" + args.command : "/review"
        if (phase !== "empty") {
          s.phase = phase
        }
        s.featureDir = featureDir ?? s.featureDir
        s.nextStep = nextStep
        s.lastResult = parts.join(" | ")
        s.history.push(args.command ? "/" + args.command : "/review")

        await writeSession(projectRoot, s)

        const valid = phase === "ready"
        return {
          title: valid ? "Ready to implement" : "Phase: " + phase,
          output: parts.join(" | ") + " | Next: " + nextStep,
          metadata: {
            valid,
            phase,
            specJsonPhase: specJsonPhase ?? null,
            mismatch,
            nextCommand: nextStep,
            featureDir: featureDir ?? null,
            artifacts: { constitution: constitutionExists, spec: specOk, plan: planOk, tasks: tasksOk },
          },
        }
      })

      return toolResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `validate: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
