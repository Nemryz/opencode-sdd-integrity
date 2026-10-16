import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import {
  getLatestFeatureDir,
  getProjectRootWarnings,
  resolveProjectRoot,
  readSession,
  readSpecJson,
  specsDirPath,
  syncFrontmatterFromSpecJson,
  writeSession,
  writeSpecJson,
} from "./shared/types"
import { postFailureNote, snapshotAfterFailure, snapshotBeforeOperation } from "./shared/snapshot/triggers"

const NEXT_STEPS: Record<string, string> = {
  impl: "/impl (continue)",
  complete: "/review or start a new feature",
}

const ALLOWED_FROM: Record<string, string> = {
  impl: "ready",
  complete: "impl",
}

export default tool({
  description: "Advance the feature phase to impl or complete after implementation work",
  args: {
    phase: tool.schema.enum(["impl", "complete"]).describe("Target phase"),
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

      const session = await readSession(projectRoot)
      const featureDir = session.featureDir ?? await getLatestFeatureDir(projectRoot)
      if (!featureDir) {
        return { title: "Error", output: "No feature found. Run /spec first." }
      }

      const base = path.join(specsDirPath(projectRoot), featureDir)
      const specJson = await readSpecJson(base)
      if (!specJson) {
        return { title: "Error", output: `spec.json not found in specs/${featureDir}` }
      }

      if (!specJson.approvals.tasks.approved) {
        return { title: "Error", output: `Tasks are not approved for ${featureDir}. Run /approve tasks first.` }
      }

      const target = args.phase
      const current = specJson.phase

      if (current === target) {
        return {
          title: `Phase: ${target}`,
          output: `Already in ${target} phase for ${featureDir}.  Next: ${NEXT_STEPS[target]}`,
          metadata: { phase: target, featureDir, previousPhase: current },
        }
      }

      if (current !== ALLOWED_FROM[target]) {
        return {
          title: "Error",
          output: `Cannot move to ${target} from ${current} for ${featureDir}. Expected current phase: ${ALLOWED_FROM[target]}.`,
          metadata: { phase: current, featureDir },
        }
      }

      const recovery = await snapshotBeforeOperation(projectRoot, `phase:${current}->${target}`, {
        feature: featureDir,
        phase: current,
      })
      if (!recovery.ok) {
        return {
          title: "Error",
          output: `phase: BLOCKED — pre-transition snapshot failed (${recovery.error ?? "unknown error"}). No changes were made. Fix .opencode/snapshots (space/permissions) or run /snapshot create, then retry.`,
          metadata: { error: recovery.error, blocked: true, featureDir, phase: current },
        }
      }

      const nextStep = NEXT_STEPS[target]
      try {
        specJson.phase = target
        await writeSpecJson(specJson, base)
        await syncFrontmatterFromSpecJson(base, specJson)

        await writeSession(projectRoot, {
          ...session,
          command: "/phase",
          phase: target,
          featureDir,
          nextStep,
          lastResult: `phase ${current} -> ${target} for ${featureDir}`,
          history: [...session.history, `/phase ${target}`],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const failure = await snapshotAfterFailure(projectRoot, `post-failure:phase-${target}`, {
          feature: featureDir,
          phase: current,
        })
        const note = postFailureNote(failure)
        return {
          title: "Error",
          output: `phase: ${message}.${note}`,
          metadata: { error: message, postFailureSnapshot: failure.snapshotId },
        }
      }

      return {
        title: `Phase: ${target}`,
        output: `${featureDir}: ${current} -> ${target}  Next: ${nextStep}`,
        metadata: {
          phase: target,
          featureDir,
          previousPhase: current,
          nextStep,
          recoverySnapshot: recovery.snapshotId,
          recoveryReused: recovery.reused,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `phase: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
