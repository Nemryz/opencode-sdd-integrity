import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import {
  PATHS,
  readSession,
  readSpecJson,
  exists,
  specsDirPath,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  clearCorruptionWarnings,
  isSafeFeatureDirName,
} from "./shared/types"
import { snapshotBeforeOperation } from "./shared/snapshot/triggers"
import { applyStatePlan } from "./shared/state/apply"
import {
  createStatePlan,
  StateTransactionError,
  type CreateStatePlanInput,
} from "./shared/state/plan"
import { hashPathTree } from "./shared/state/paths"
import type { StatePlan } from "./shared/schemas"

export function todayStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export default tool({
  description: "Archive a completed feature by moving its directory from specs/ to archive/",
  args: {
    featureDir: tool.schema.string().optional().describe("Feature directory (e.g., 001-demo). If omitted, uses the latest feature."),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the archive operation"),
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

      clearCorruptionWarnings()
      const specsDir = specsDirPath(projectRoot)
      const archiveDir = path.join(projectRoot, "archive")

      // Resolve feature dir
      let featureDirName = args.featureDir
      if (!featureDirName) {
        // Find latest feature
        const entries = await fs.readdir(specsDir).catch(() => [])
        const featureDirs = entries.filter((e) => /^\d{3}-/.test(e)).sort()
        if (featureDirs.length === 0) {
          return { title: "Error", output: "No features found in specs/. Run /spec first." }
        }
        featureDirName = featureDirs[featureDirs.length - 1]
      }

      if (!isSafeFeatureDirName(featureDirName)) {
        return { title: "Error", output: `Invalid feature directory name: ${featureDirName}` }
      }
      const featurePath = path.join(specsDir, featureDirName)
      const specJson = await readSpecJson(featurePath)
      if (!specJson) {
        return { title: "Error", output: `No spec.json found for ${featureDirName}. Run /spec first.` }
      }

      if (specJson.phase !== "complete") {
        return {
          title: "Error",
          output: `Feature ${featureDirName} is not complete (phase: ${specJson.phase}). Run /impl first, then /converge.`,
        }
      }

      if (specJson.converged === false && !args.confirmed) {
        return {
          title: "Warning",
          output: `Feature ${featureDirName} has not converged. Archive anyway? Re-run with confirmed: true to proceed.`,
          metadata: { requiresConfirmation: true },
        }
      }

      // Check if already archived
      const archiveExists = await exists(path.join(archiveDir, featureDirName))
      if (archiveExists) {
        return { title: "Error", output: `Feature ${featureDirName} is already archived.` }
      }

      // Snapshot before operation
      const recovery = await snapshotBeforeOperation(projectRoot, "archive", {
        feature: featureDirName,
        phase: specJson.phase,
      })
      if (!recovery.ok) {
        return {
          title: "Error",
          output: `archive: BLOCKED — pre-archive snapshot failed (${recovery.error ?? "unknown error"}). Fix .opencode/snapshots or run /snapshot create, then retry.`,
        }
      }

      const dateStamp = todayStamp()
      let archiveName = `${dateStamp}-${featureDirName}`
      let archivePath = path.join(archiveDir, archiveName)

      // Handle collision
      let counter = 1
      while (await exists(archivePath)) {
        counter++
        archiveName = `${dateStamp}-${featureDirName}-${counter}`
        archivePath = path.join(archiveDir, archiveName)
      }

      const now = new Date()
      const session = await readSession(projectRoot)
      const sessionRel = `${PATHS.OPENCODE_DIR}/${PATHS.SPEC_MEMORY_DIR}/${PATHS.SESSION_FILE}`
      const featureRel = `specs/${featureDirName}`

      const buildPlan = async (name: string): Promise<StatePlan> => {
        const targetRel = `archive/${name}`
        const featureHash = await hashPathTree(projectRoot, featureRel)
        const targetSession = session.featureDir === featureDirName
        const preconditions: CreateStatePlanInput["preconditions"] = [
          featureHash === "absent"
            ? { path: featureRel, kind: "dir" }
            : { path: featureRel, kind: "dir", sha256: featureHash },
          { path: targetRel, kind: "absent" },
        ]
        const operations: CreateStatePlanInput["operations"] = [
          { kind: "rename-dir", from: featureRel, to: targetRel },
          {
            kind: "write-spec-json",
            featureDir: targetRel,
            data: { ...specJson, archived_at: now.toISOString() },
          },
        ]
        if (targetSession) {
          const sessionHash = await hashPathTree(projectRoot, sessionRel)
          preconditions.push(
            sessionHash === "absent"
              ? { path: sessionRel, kind: "file" }
              : { path: sessionRel, kind: "file", sha256: sessionHash },
          )
          operations.push({
            kind: "write-session",
            data: {
              ...session,
              featureDir: null,
              phase: "spec",
              nextStep: "/spec <description>",
              history: [...session.history],
            },
          })
        }
        return createStatePlan({
          root: projectRoot,
          scope: [featureRel, targetRel, ...(targetSession ? [sessionRel] : [])],
          preconditions,
          operations,
          now,
        })
      }

      let plan: StatePlan | null = null
      let lastError: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          plan = await buildPlan(archiveName)
          await applyStatePlan(projectRoot, plan)
          lastError = null
          break
        } catch (err) {
          lastError = err
          const targetConflict = err instanceof StateTransactionError && err.code === "TARGET_EXISTS"
          if (!targetConflict || attempt === 1) break
          counter++
          archiveName = `${dateStamp}-${featureDirName}-${counter}`
          archivePath = path.join(archiveDir, archiveName)
        }
      }
      if (!plan || lastError) {
        if (lastError instanceof StateTransactionError && lastError.code === "TARGET_EXISTS") {
          return {
            title: "Conflict",
            output: `Archive target kept changing for ${featureDirName}. Nothing was moved; retry when the archive directory is stable.`,
          }
        }
        throw lastError ?? new Error("archive plan was not created")
      }

      const movedFiles = await fs.readdir(archivePath)
      return {
        title: "Archived",
        output: `Feature ${featureDirName} archived to ${archivePath}.\nFiles moved: ${movedFiles.join(", ")}\nRun /status to see updated state.`,
        metadata: { archivePath, movedFiles },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { title: "Error", output: `Archive failed: ${msg}` }
    }
  },
})