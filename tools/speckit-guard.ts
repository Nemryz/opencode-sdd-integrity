import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveProjectRoot, getProjectRootWarnings, withLock, writeWithBackup, stripBom } from "./shared/types"
import {
  DEFAULT_CONFIG,
  GuardConfigSchema,
  cloneConfig,
  guardBasename,
  isProtectedFile,
  migrateGuardConfig,
  normalizeGuardPath,
  type GuardConfig,
} from "./plugins/speckit-guard"

function formatOutput(config: GuardConfig): string {
  const lines = [
    `Guard Status: ${config.enabled ? "ENABLED" : "DISABLED"} | Debug: ${config.debug ? "ON" : "OFF"}`,
    "",
    "Protected Files (Always):",
  ]

  for (const file of config.protectedFiles) {
    lines.push(`  ${file}`)
  }

  lines.push("")
  lines.push("Protected After Approval:")
  for (const file of config.protectedAfterApproval) {
    lines.push(`  ${file} (after ${file.replace(/\.[^.]+$/, "")} approval)`)
  }

  lines.push("")
  lines.push("Protected By Phase:")
  for (const [phase, files] of Object.entries(config.protectedByPhase)) {
    for (const file of files) {
      lines.push(`  ${file} (${phase})`)
    }
  }

  lines.push("")
  lines.push("Statistics:")
  lines.push(`  Denied: ${config.stats.denied}`)
  lines.push(`  Allowed: ${config.stats.allowed}`)
  lines.push(`  Asked: ${config.stats.asked}`)

  if (config.denials.length > 0) {
    lines.push("")
    lines.push(`Recent Denials (${config.denials.length}):`)
    for (const denial of config.denials) {
      const date = new Date(denial.timestamp)
      const dateStr = date.toISOString().slice(0, 16).replace("T", " ")
      lines.push(`  [${dateStr}] ${denial.file} - ${denial.reason}`)
    }
  }

  return lines.join("\n")
}

export default tool({
  description: "Manage file protection guard for critical SDD artifacts",
  args: {
    subcommand: tool.schema.enum(["on", "off", "status", "add", "remove", "log", "debug"]).optional().describe("Guard subcommand"),
    file: tool.schema.string().optional().describe("File path for add/remove commands"),
    logOption: tool.schema.enum(["all"]).optional().describe("Log option for save all denials"),
    debugOption: tool.schema.enum(["on", "off"]).optional().describe("Debug option"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms a destructive operation"),
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

      const configPath = path.join(projectRoot, ".opencode", "guard.json")

      async function readConfig(): Promise<GuardConfig> {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(stripBom(await fs.readFile(configPath, "utf-8")))
        } catch {
          return cloneConfig(DEFAULT_CONFIG)
        }
        const result = GuardConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...(parsed as object) })
        return result.success ? migrateGuardConfig(result.data) : cloneConfig(DEFAULT_CONFIG)
      }

      async function writeConfig(config: GuardConfig): Promise<void> {
        const result = GuardConfigSchema.safeParse(config)
        if (!result.success) return
        await withLock(configPath, async () => {
          await writeWithBackup(configPath, JSON.stringify(result.data, null, 2), projectRoot)
        })
      }

      const subcommand = args.subcommand || "status"

      if (subcommand === "status") {
        const config = await readConfig()
        return {
          title: "Guard Status",
          output: formatOutput(config),
        }
      }

      if (subcommand === "on") {
        const config = await readConfig()
        config.enabled = true
        await writeConfig(config)
        return {
          title: "Guard Enabled",
          output: "File protection guard has been enabled.",
        }
      }

      if (subcommand === "off") {
        if (!args.confirmed) {
          return {
            title: "Confirm Guard Disable",
            output: "Are you sure you want to disable the file protection guard? This will allow edits to all protected files. Ask the user to confirm, then re-run with confirmed: true.",
            metadata: { requiresConfirmation: true },
          }
        }
        const config = await readConfig()
        config.enabled = false
        await writeConfig(config)
        return {
          title: "Guard Disabled",
          output: "File protection guard has been disabled.",
        }
      }

      if (subcommand === "add") {
        if (!args.file) {
          return { title: "Error", output: "Please specify a file to add to protection." }
        }
        const config = await readConfig()
        if (config.protectedFiles.includes(args.file)) {
          return {
            title: "Already Protected",
            output: `${args.file} is already in the always-protected list. Nothing changed.`,
          }
        }
        config.protectedFiles.push(args.file)
        await writeConfig(config)
        return {
          title: "File Added",
          output: `${args.file} has been added to protected files.`,
        }
      }

      if (subcommand === "remove") {
        if (!args.file) {
          return { title: "Error", output: "Please specify a file to remove from protection." }
        }
        if (!args.confirmed) {
          return {
            title: "Confirm Remove Protection",
            output: `Are you sure you want to remove protection for ${args.file}? This will allow edits to that file. Ask the user to confirm, then re-run with confirmed: true.`,
            metadata: { requiresConfirmation: true },
          }
        }
        const config = await readConfig()

        if (config.protectedFiles.includes(args.file)) {
          config.protectedFiles = config.protectedFiles.filter(f => f !== args.file)
          await writeConfig(config)
          return {
            title: "Protection Removed",
            output: `${args.file} has been removed from protected files.`,
          }
        }

        const patternReason = isProtectedFile(args.file, config)
        if (patternReason) {
          return {
            title: "Protected By Pattern",
            output: `${args.file} matches an always-protected pattern (${patternReason}), so removing this exact string would have no effect. Remove the pattern entry itself, or use "/guard off" (with confirmation) only if strictly needed. Nothing was removed.`,
          }
        }

        const base = guardBasename(normalizeGuardPath(args.file))
        const afterApproval = config.protectedAfterApproval.some(f => guardBasename(normalizeGuardPath(f)) === base)
        const byPhase = Object.values(config.protectedByPhase).some(files => files.some(f => guardBasename(normalizeGuardPath(f)) === base))
        if (afterApproval || byPhase) {
          const how = afterApproval ? "after approval" : "by workflow phase"
          return {
            title: "Protected Dynamically",
            output: `${args.file} is not in the always-protected list. It is protected ${how} based on spec.json state, so it cannot be removed individually. To change an approved artifact, edit it and re-approve with "/approve <artifact>"; use "/guard off" (with confirmation) only if strictly needed. Nothing was removed.`,
          }
        }

        return {
          title: "Not Protected",
          output: `${args.file} is not in the always-protected list. Nothing was removed.`,
        }
      }

      if (subcommand === "log") {
        const config = await readConfig()
        if (args.logOption === "all") {
          const logPath = path.join(projectRoot, ".opencode", "guard-log.json")
          await fs.writeFile(logPath, JSON.stringify(config.denials, null, 2))
          return {
            title: "Log Saved",
            output: `All ${config.denials.length} denials saved to .opencode/guard-log.json`,
          }
        }
        if (config.denials.length === 0) {
          return {
            title: "Guard Log",
            output: "No denials recorded.",
          }
        }
        const lines = [`Recent Denials (${config.denials.length}):`]
        for (const denial of config.denials) {
          const date = new Date(denial.timestamp)
          const dateStr = date.toISOString().slice(0, 16).replace("T", " ")
          lines.push(`  [${dateStr}] ${denial.file} - ${denial.reason}`)
        }
        return {
          title: "Guard Log",
          output: lines.join("\n"),
        }
      }

      if (subcommand === "debug") {
        const config = await readConfig()
        if (args.debugOption === "on") {
          config.debug = true
          await writeConfig(config)
          return {
            title: "Debug Enabled",
            output: "Debug mode enabled. Guard decisions will be logged to console.",
          }
        }
        if (args.debugOption === "off") {
          config.debug = false
          await writeConfig(config)
          return {
            title: "Debug Disabled",
            output: "Debug mode disabled.",
          }
        }
        return {
          title: "Debug Status",
          output: `Debug mode is ${config.debug ? "ON" : "OFF"}.`,
        }
      }

      return {
        title: "Error",
        output: "Unknown subcommand. Use /guard, /guard on, /guard off, /guard status, /guard add <file>, /guard remove <file>, /guard log, /guard debug on|off.",
      }
    } catch (err) {
      return {
        title: "Error",
        output: `Guard operation failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})
