import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import {
  exists,
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
import { computeBodyChecksum } from "./shared/io"
import { postFailureNote, snapshotAfterFailure, snapshotBeforeOperation } from "./shared/snapshot/triggers"

const ARTIFACT_FILES: Record<string, string> = {
  spec: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
}

const ARTIFACT_NEXT_STEPS: Record<string, string> = {
  spec: "/plan <tech stack>",
  plan: "/tasks",
  tasks: "/impl or /review",
}

export default tool({
  description: "Approve a generated artifact so the workflow can advance to the next phase",
  args: {
    artifact: tool.schema.enum(["spec", "plan", "tasks"]).optional().describe("Artifact to approve"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the approval"),
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

      if (!args.artifact) {
        const order = ["spec", "plan", "tasks"] as const
        const states = order.map(a => {
          const state = specJson.approvals[a]
          if (!state.generated) return `${a}: not generated`
          if (state.approved) return `${a}: approved`
          return `${a}: pending`
        })
        const pending = order.find(a => specJson.approvals[a].generated && !specJson.approvals[a].approved) ?? null
        const hint = pending ? `  Next: /approve ${pending}` : ""
        return {
          title: pending ? `Approval pending: ${pending}` : "Approval status",
          output: states.join(" | ") + hint,
          metadata: { artifact: null, pending, featureDir, approvals: specJson.approvals },
        }
      }
      const artifact = args.artifact

      const artifactFile = ARTIFACT_FILES[artifact]
      const artifactPath = path.join(base, artifactFile)
      if (!await exists(artifactPath)) {
        return { title: "Error", output: `${artifactFile} does not exist in specs/${featureDir}. Generate it first.` }
      }

      if (specJson.approvals[artifact].approved) {
        const content = await fs.readFile(artifactPath, "utf-8")
        const currentHash = computeBodyChecksum(content)
        const storedHash = specJson.approvals[artifact].hash

        if (storedHash && storedHash !== currentHash) {
          if (!args.confirmed) {
            return {
              title: "Confirm Re-Approval",
              output: `${artifactFile} changed since it was approved for ${featureDir}. Re-approve to record the current content? Ask the user to confirm, then re-run with confirmed: true.`,
              metadata: { requiresConfirmation: true, artifact, featureDir, drift: true },
            }
          }
          specJson.approvals[artifact].hash = currentHash
          specJson.approvals[artifact].approved_at = new Date().toISOString()
          await writeSpecJson(specJson, base)
          return {
            title: `${artifact} re-approved`,
            output: `${artifact} re-approved for ${featureDir} (content changed since last approval)  Next: ${ARTIFACT_NEXT_STEPS[artifact]}`,
            metadata: { artifact, featureDir, reapproved: true },
          }
        }

        if (!storedHash) {
          specJson.approvals[artifact].hash = currentHash
          specJson.approvals[artifact].approved_at = new Date().toISOString()
          await writeSpecJson(specJson, base)
        }

        return {
          title: `${artifact} already approved`,
          output: `${artifact} is already approved for ${featureDir}.`,
          metadata: { artifact, featureDir },
        }
      }

      if (!args.confirmed) {
        return {
          title: "Confirm Approval",
          output: `Approve ${artifact} for ${featureDir}? This records the approval and unlocks the next workflow phase. Ask the user to confirm, then re-run with confirmed: true.`,
          metadata: { requiresConfirmation: true, artifact, featureDir },
        }
      }

      let recoverySnapshot: string | null = null
      if (artifact === "tasks") {
        const recovery = await snapshotBeforeOperation(projectRoot, "phase:tasks->ready", {
          feature: featureDir,
          phase: specJson.phase,
        })
        if (!recovery.ok) {
          return {
            title: "Error",
            output: `approve: BLOCKED — pre-approval snapshot failed (${recovery.error ?? "unknown error"}). tasks not approved. Fix .opencode/snapshots (space/permissions) or run /snapshot create, then retry.`,
            metadata: { error: recovery.error, blocked: true, artifact, featureDir },
          }
        }
        recoverySnapshot = recovery.snapshotId
      }

      const nextStep = ARTIFACT_NEXT_STEPS[artifact]
      try {
        specJson.approvals[artifact].approved = true
        if (artifact === "tasks") {
          specJson.phase = "ready"
          specJson.ready_for_implementation = true
        }
        const approvedContent = await fs.readFile(artifactPath, "utf-8")
        specJson.approvals[artifact].hash = computeBodyChecksum(approvedContent)
        specJson.approvals[artifact].approved_at = new Date().toISOString()
        await writeSpecJson(specJson, base)
        await syncFrontmatterFromSpecJson(base, specJson)

        await writeSession(projectRoot, {
          ...session,
          command: "/approve",
          phase: session.phase,
          featureDir,
          nextStep,
          lastResult: `${artifact} approved for ${featureDir}`,
          history: [...session.history, `/approve ${artifact}`],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const failure = await snapshotAfterFailure(projectRoot, `post-failure:approve-${artifact}`, {
          feature: featureDir,
          phase: specJson.phase,
        })
        const note = postFailureNote(failure)
        return {
          title: "Error",
          output: `approve: ${message}.${note}`,
          metadata: { error: message, postFailureSnapshot: failure.snapshotId },
        }
      }

      return {
        title: `${artifact} approved`,
        output: `${artifact} approved for ${featureDir}  Next: ${nextStep}`,
        metadata: { artifact, featureDir, nextStep, recoverySnapshot },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `approve: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
