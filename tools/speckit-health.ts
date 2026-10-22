import { tool } from "@opencode-ai/plugin"
import {
  runHealthCheck,
  readConfigWithRestore,
  findLatestValidBackup,
  writeSession,
  writeConfigWithBackup,
  writeWithBackup,
  clearCorruptionWarnings,
  corruptionWarnings,
  resolveProjectRoot,
  getProjectRootWarnings,
  detectParentProjectWithoutSession,
  sessionPath,
  configPath,
  specsDirPath,
  specJsonPath,
  stripBom,
  SessionStateSchema,
  ConfigSchema,
  SpecJsonSchema,
  inspectStateTransactions,
  recoverStateTransactions,
} from "./shared/types"
import path from "node:path"
import fs from "node:fs/promises"
import { exists } from "./shared/types"
import { DEFAULT_CONFIG, GuardConfigSchema } from "./plugins/speckit-guard"
import { readRestoreJournal } from "./shared/snapshot/paths"
import { listSnapshots } from "./shared/snapshot/manifest"
import { recoverInterruptedRestore } from "./shared/snapshot/restore"
import { computeRecoveryReadiness } from "./shared/snapshot/retention"
import { postFailureNote, snapshotAfterFailure, snapshotBeforeOperation } from "./shared/snapshot/triggers"

async function guardConfigStatus(fp: string): Promise<"healthy" | "corrupted" | "missing"> {
  try {
    const raw = await fs.readFile(fp, "utf-8")
    const parsed = GuardConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...(JSON.parse(stripBom(raw)) as object) })
    return parsed.success ? "healthy" : "corrupted"
  } catch {
    return "missing"
  }
}

export default tool({
  description: "Run health check, analyze findings, and apply fixes with auto-rollback protection",
  args: {
    fix: tool.schema.boolean().optional().describe("Apply auto-fixes for detected issues"),
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

      const transactionLines: string[] = []
      if (args.fix) {
        const transactionRecovery = await recoverStateTransactions(projectRoot)
        for (const txId of transactionRecovery.recovered) {
          transactionLines.push(`  Interrupted state transaction recovered: ${txId}`)
        }
      } else {
        const pendingTransactions = await inspectStateTransactions(projectRoot)
        for (const transaction of pendingTransactions) {
          transactionLines.push(`  State transaction ${transaction.txId} is ${transaction.state} — run /health --fix to recover`)
        }
      }

      const recoveryLines: string[] = []
      const pendingJournal = await readRestoreJournal(projectRoot)
      if (pendingJournal) {
        if (args.fix) {
          const recovery = await recoverInterruptedRestore(projectRoot)
          if (recovery.recovered) {
            recoveryLines.push(`  Interrupted restore recovered from safety snapshot ${recovery.safetySnapshotId}`)
          } else {
            recoveryLines.push(`  Interrupted restore recovery FAILED: ${recovery.error ?? "unknown error"}`)
          }
        } else {
          recoveryLines.push("  Interrupted restore pending — run /health --fix or /snapshot recover")
        }
      }

      const report = await runHealthCheck(projectRoot)

      const guardFp = path.join(projectRoot, ".opencode", "guard.json")
      let guardStatus: "healthy" | "corrupted" | "missing" | "restored" = await guardConfigStatus(guardFp)

      let fixBlockedNote = ""
      if (args.fix) {
        const recovery = await snapshotBeforeOperation(projectRoot, "pre-fix:health")
        if (!recovery.ok) {
          fixBlockedNote = `  Fix blocked: pre-fix snapshot failed (${recovery.error ?? "unknown error"}). No changes applied.`
        } else {
          try {
            let fixedCount = 0

            // Fix session.json
            if (report.session.status === "corrupted" || report.session.status === "missing") {
              const restored = await findLatestValidBackup(report.session.file, projectRoot, SessionStateSchema)
              if (restored) {
                await writeSession(projectRoot, restored)
                report.session.status = "restored"
                fixedCount++
              }
            }

            // Fix config.json
            if (report.config.status === "corrupted" || report.config.status === "missing") {
              const restored = await findLatestValidBackup(report.config.file, projectRoot, ConfigSchema)
              if (restored) {
                await writeConfigWithBackup(projectRoot, restored)
                report.config.status = "restored"
                fixedCount++
              }
            }

            // Fix guard.json
            if (guardStatus === "corrupted" || guardStatus === "missing") {
              const restored = await findLatestValidBackup(guardFp, projectRoot, GuardConfigSchema)
              if (restored) {
                await writeWithBackup(guardFp, JSON.stringify(restored, null, 2), projectRoot)
                guardStatus = "restored"
                fixedCount++
              }
            }

            // Fix features
            const sDir = specsDirPath(projectRoot)
            for (const feature of report.features) {
              if (feature.spec_json === "corrupted" || feature.spec_json === "missing") {
                const base = path.join(sDir, feature.dir)
                const sjFp = specJsonPath(base)
                const restored = await findLatestValidBackup(sjFp, projectRoot, SpecJsonSchema)
                if (restored) {
                  const { writeSpecJson } = await import("./shared/io")
                  await writeSpecJson(restored, base)
                  feature.spec_json = "restored"
                  fixedCount++
                }
              }
            }

            if (fixedCount > 0) {
              const hasMissing = report.session.status === "missing" || report.config.status === "missing"
                || report.features.some(f => f.spec_json === "missing")
              const hasCorrupted = report.session.status === "corrupted" || report.config.status === "corrupted"
                || guardStatus === "corrupted"
                || report.features.some(f => f.spec_json === "corrupted")
              const hasRestored = report.session.status === "restored" || report.config.status === "restored"
                || guardStatus === "restored"
                || report.features.some(f => f.spec_json === "restored")
              if (hasMissing) report.overall = "critical"
              else if (hasCorrupted || hasRestored) report.overall = "degraded"
              else report.overall = "healthy"
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const failure = await snapshotAfterFailure(projectRoot, "post-failure:health")
            fixBlockedNote = `  Fix failed: ${message}.${postFailureNote(failure)}`
          }
        }
      }

      const lines: string[] = []
      const sessionTag = report.session.status === "healthy" ? "healthy" : report.session.status === "restored" ? "restored from backup" : report.session.status
      lines.push(`  session.json: ${sessionTag}`)

      const configTag = report.config.status === "healthy" ? "healthy" : report.config.status === "restored" ? "restored from backup" : report.config.status
      lines.push(`  config.json: ${configTag}`)

      const guardTag = guardStatus === "healthy" ? "healthy" : guardStatus === "restored" ? "restored from backup" : guardStatus === "missing" ? "missing (defaults apply)" : guardStatus
      lines.push(`  guard.json: ${guardTag}`)

      const healthyFeatures = report.features.filter(f => f.spec_json === "healthy").length
      const totalFeatures = report.features.length
      lines.push(`  Features: ${healthyFeatures}/${totalFeatures} healthy`)

      for (const feature of report.features) {
        const statusTag = feature.spec_json === "healthy" ? "healthy" : feature.spec_json === "restored" ? `restored from backup (${feature.backups.corrupted} corrupted backup(s))` : feature.spec_json
        const backupInfo = feature.backups.total > 0 ? ` (${feature.backups.total} backups, ${feature.backups.valid} valid)` : ""
        lines.push(`    ${feature.dir}: ${statusTag}${backupInfo}`)
      }

      const journalAfter = await readRestoreJournal(projectRoot)
      const snapshotEntries = await listSnapshots(projectRoot)
      const readiness = computeRecoveryReadiness(snapshotEntries, journalAfter !== null)
      lines.push(`  Snapshots: ${snapshotEntries.length} | Recovery Readiness: ${readiness.status}`)
      for (const reason of readiness.reasons) {
        lines.push(`    - ${reason}`)
      }

      const corruptionLines = corruptionWarnings.map(w => `  [CORRUPTION] ${w.file}: ${w.message}`)
      clearCorruptionWarnings()

      const overallTag = report.overall === "healthy" ? "HEALTHY" : report.overall === "degraded" ? "DEGRADED" : "CRITICAL"
      const title = `Session Health: ${overallTag}`
      const output = [
        title,
        ...recoveryLines,
        ...transactionLines,
        ...lines,
        ...(fixBlockedNote ? [fixBlockedNote] : []),
        ...corruptionLines,
        `  Overall: ${report.overall.toUpperCase()}`,
      ].join("\n")

      return {
        title,
        output,
        metadata: { ...report, guard: guardStatus, readiness: readiness.status },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { title: "Error", output: `Health check failed: ${msg}` }
    }
  },
})
