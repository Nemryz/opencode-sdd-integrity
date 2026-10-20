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
  specsDirPath,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  withLock,
  clearCorruptionWarnings,
  specJsonPath,
  sessionPath,
} from "./shared/types"
import { snapshotBeforeOperation } from "./shared/snapshot/triggers"

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

      if (specJson.converged === false) {
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

      await fs.mkdir(archiveDir, { recursive: true })
      await fs.mkdir(archivePath, { recursive: true })

      // Move all files
      const entries = await fs.readdir(featurePath)
      for (const entry of entries) {
        await fs.rename(path.join(featurePath, entry), path.join(archivePath, entry))
      }
      // Remove empty feature dir
      await fs.rmdir(featurePath).catch(() => {})

      // Update spec.json with archived_at
      const archivedSpecJson = await readSpecJson(archivePath)
      if (archivedSpecJson) {
        archivedSpecJson.archived_at = new Date().toISOString()
        await writeSpecJson(archivedSpecJson, archivePath)
      }

      // Update session.json if it references this feature
      const session = await readSession(projectRoot)
      if (session && session.featureDir === featureDirName) {
        session.featureDir = null
        session.phase = "spec"
        session.nextStep = "/spec <description>"
        await writeSession(projectRoot, session)
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