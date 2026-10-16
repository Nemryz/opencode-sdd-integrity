import { tool } from "@opencode-ai/plugin"
import {
  getProjectRootWarnings,
  readSession,
  resolveProjectRoot,
} from "./shared/types"
import { readRestoreJournal } from "./shared/snapshot/paths"
import { SnapshotListEntry, createSnapshot, listSnapshots, verifySnapshot } from "./shared/snapshot/manifest"
import { previewRestore, recoverInterruptedRestore, restoreSnapshot } from "./shared/snapshot/restore"
import { computeRecoveryReadiness, drillSnapshot, pinSnapshot, pruneSnapshots, unpinSnapshot } from "./shared/snapshot/retention"

const SUBCOMMANDS = ["create", "list", "verify", "preview", "restore", "pin", "unpin", "drill", "prune", "recover"]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatEntry(entry: SnapshotListEntry): string {
  return [
    entry.id,
    entry.createdAt ?? "unknown",
    entry.trigger ?? "unknown",
    entry.feature ?? "no feature",
    `${entry.fileCount} files`,
    formatBytes(entry.totalSize),
    entry.status,
    entry.pinned ? `pinned${entry.label ? `:${entry.label}` : ""}` : "unpinned",
    `drill:${entry.drill}`,
  ].join(" | ")
}

export default tool({
  description: "Create, inspect, restore, and prune point-in-time snapshots of the SDD state",
  args: {
    subcommand: tool.schema
      .enum(["create", "list", "verify", "preview", "restore", "pin", "unpin", "drill", "prune", "recover"])
      .optional()
      .describe("Snapshot subcommand (default: list)"),
    id: tool.schema.string().optional().describe("Snapshot id, or 'latest' for the newest snapshot"),
    mode: tool.schema.enum(["full", "selective"]).optional().describe("Restore or preview mode (default: full)"),
    files: tool.schema.array(tool.schema.string()).optional().describe("Project-relative paths for selective mode"),
    label: tool.schema.string().optional().describe("Label to attach when pinning"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms"),
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
          output: `${projectWarnings.map((w) => w.message).join("\n\n")}\n\nAsk the user to confirm, then re-run with confirmed: true.`,
          metadata: { warnings: projectWarnings, requiresConfirmation: true },
        }
      }

      const subcommand = args.subcommand ?? "list"

      const resolveId = async (): Promise<string | null> => {
        if (!args.id) return null
        if (args.id !== "latest") return args.id
        const entries = await listSnapshots(projectRoot)
        return entries[0]?.id ?? null
      }

      if (subcommand === "create") {
        const session = await readSession(projectRoot)
        const manifest = await createSnapshot(projectRoot, {
          trigger: "manual",
          feature: session.featureDir,
          phase: session.phase,
        })
        const totalSize = manifest.files.reduce((sum, file) => sum + file.size, 0)
        return {
          title: "Snapshot Created",
          output: [
            manifest.id,
            `  files: ${manifest.files.length} (${formatBytes(totalSize)})`,
            `  feature: ${manifest.feature ?? "none"} | phase: ${manifest.phase ?? "unknown"}`,
            `Next: /snapshot drill ${manifest.id} to prove it can be restored`,
          ].join("\n"),
          metadata: { snapshotId: manifest.id, files: manifest.files.length },
        }
      }

      if (subcommand === "list") {
        const entries = await listSnapshots(projectRoot)
        const journal = await readRestoreJournal(projectRoot)
        const readiness = computeRecoveryReadiness(entries, journal !== null)
        const lines = [
          `Recovery Readiness: ${readiness.status}`,
          ...readiness.reasons.map((reason) => `  - ${reason}`),
          "",
          `Snapshots (${entries.length}):`,
        ]
        if (entries.length === 0) {
          lines.push("  (none)")
        } else {
          lines.push(...entries.map((entry) => `  ${formatEntry(entry)}`))
        }
        return {
          title: `Snapshots: ${readiness.status}`,
          output: lines.join("\n"),
          metadata: { readiness: readiness.status, count: entries.length, snapshots: entries },
        }
      }

      if (subcommand === "verify") {
        const id = await resolveId()
        if (!id) return { title: "Error", output: "Provide a snapshot id (or 'latest') to verify." }
        const verification = await verifySnapshot(projectRoot, id)
        if (!verification.manifest) return { title: "Error", output: `snapshot ${id} is unreadable` }
        if (verification.ok) {
          return {
            title: "Snapshot Verified",
            output: `${id}: ${verification.entries.length} files verified, 0 problems`,
            metadata: { snapshotId: id, ok: true },
          }
        }
        const problems = verification.entries.filter((entry) => entry.status !== "ok")
        return {
          title: "Snapshot Problems",
          output: [
            `${id}: ${problems.length} problem(s)`,
            ...problems.map((problem) => `  ${problem.status}: ${problem.path}`),
          ].join("\n"),
          metadata: { snapshotId: id, ok: false, problems },
        }
      }

      if (subcommand === "preview") {
        const id = await resolveId()
        if (!id) return { title: "Error", output: "Provide a snapshot id (or 'latest') to preview." }
        const preview = await previewRestore(projectRoot, id, { mode: args.mode, files: args.files })
        const changed = preview.entries.filter((entry) => entry.status === "changed")
        const missing = preview.entries.filter((entry) => entry.status === "missing")
        const identical = preview.entries.filter((entry) => entry.status === "identical")
        const lines = [
          `Preview restore ${id} (${preview.mode}) — nothing was written`,
          `  changed: ${changed.length}`,
          ...changed.map((entry) => `    ${entry.path}`),
          `  missing (would be created): ${missing.length}`,
          ...missing.map((entry) => `    ${entry.path}`),
          `  identical: ${identical.length}`,
          `  extras (would be removed): ${preview.extras.length}`,
          ...preview.extras.map((extra) => `    ${extra}`),
        ]
        if (preview.errors.length > 0) {
          lines.push(`  errors: ${preview.errors.join("; ")}`)
        }
        return { title: "Restore Preview", output: lines.join("\n"), metadata: { snapshotId: id, ...preview } }
      }

      if (subcommand === "restore") {
        const id = await resolveId()
        if (!id) return { title: "Error", output: "Provide a snapshot id (or 'latest') to restore." }
        if (!args.confirmed) {
          let impact = "Impact: preview unavailable."
          try {
            const preview = await previewRestore(projectRoot, id, { mode: args.mode, files: args.files })
            const changed = preview.entries.filter((entry) => entry.status === "changed").length
            const missing = preview.entries.filter((entry) => entry.status === "missing").length
            impact = `Impact: ${changed} changed, ${missing} created, ${preview.extras.length} removed.`
          } catch {
            // preview is best-effort in the confirmation message
          }
          return {
            title: "Confirm Restore",
            output: `Restore ${id}? ${impact} A pre-restore safety snapshot is taken first and the restore rolls back on failure. Ask the user to confirm, then re-run with confirmed: true.`,
            metadata: { requiresConfirmation: true, snapshotId: id, mode: args.mode ?? "full" },
          }
        }
        const report = await restoreSnapshot(projectRoot, id, { confirmed: true, mode: args.mode, files: args.files })
        return {
          title: "Restore Complete",
          output: [
            `restored ${report.restored.length} file(s), removed ${report.removed.length} extra(s)`,
            `safety snapshot: ${report.safetySnapshotId}`,
          ].join("\n"),
          metadata: report,
        }
      }

      if (subcommand === "pin" || subcommand === "unpin") {
        const id = await resolveId()
        if (!id) return { title: "Error", output: `Provide a snapshot id (or 'latest') to ${subcommand}.` }
        if (subcommand === "pin") {
          const pin = await pinSnapshot(projectRoot, id, args.label ?? null)
          return {
            title: "Snapshot Pinned",
            output: `${id} pinned${pin.label ? ` as "${pin.label}"` : ""} — retention will never remove it`,
            metadata: { snapshotId: id, pin },
          }
        }
        const existed = await unpinSnapshot(projectRoot, id)
        return {
          title: "Snapshot Unpinned",
          output: existed ? `${id} unpinned` : `${id} had no pin`,
          metadata: { snapshotId: id, existed },
        }
      }

      if (subcommand === "drill") {
        const id = await resolveId()
        if (!id) return { title: "Error", output: "Provide a snapshot id (or 'latest') to drill." }
        const drill = await drillSnapshot(projectRoot, id)
        if (drill.ok) {
          return {
            title: "Drill Passed",
            output: `${id}: ${drill.files_checked} files restored and verified in a sandbox`,
            metadata: { snapshotId: id, drill },
          }
        }
        return {
          title: "Drill Failed",
          output: `${id}: ${drill.error ?? "unknown error"} — this snapshot is not safe to rely on`,
          metadata: { snapshotId: id, drill },
        }
      }

      if (subcommand === "prune") {
        const report = await pruneSnapshots(projectRoot)
        if (report.aborted) {
          return { title: "Prune Aborted", output: report.abortReason ?? "prune aborted", metadata: report }
        }
        const lines = [`removed ${report.removed.length}, kept ${report.kept}`]
        for (const id of report.removed) lines.push(`  removed: ${id}`)
        for (const id of report.protectedIds) lines.push(`  protected: ${id}`)
        for (const id of report.unreadable) lines.push(`  unreadable (kept): ${id}`)
        return { title: "Prune Complete", output: lines.join("\n"), metadata: report }
      }

      if (subcommand === "recover") {
        const recovery = await recoverInterruptedRestore(projectRoot)
        if (recovery.recovered) {
          return {
            title: "Restore Recovered",
            output: `interrupted restore rolled back from safety snapshot ${recovery.safetySnapshotId}`,
            metadata: recovery,
          }
        }
        if (recovery.error === null) {
          return { title: "Nothing to Recover", output: "No interrupted restore found.", metadata: recovery }
        }
        return { title: "Recovery Failed", output: `could not recover: ${recovery.error}`, metadata: recovery }
      }

      return { title: "Error", output: `Unknown subcommand. Use: ${SUBCOMMANDS.join(", ")}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `snapshot: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
