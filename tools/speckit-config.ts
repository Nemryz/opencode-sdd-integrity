import { tool } from "@opencode-ai/plugin"
import {
  configPath,
  resolveProjectRoot,
  getProjectRootWarnings,
  SDDConfig,
  ConfigSchema,
  writeConfigWithBackup,
  readConfigWithRestore,
  withLock,
  clearCorruptionWarnings,
  withStateLock,
} from "./shared/types"

export default tool({
  description: "Read or update SDD configuration (tech stack defaults, preferences)",
  args: {
    key: tool.schema.string().optional().describe("Config key to read or set"),
    value: tool.schema.string().optional().describe("Value to set (omit to read current)"),
    defaultTechStack: tool.schema.string().optional().describe("Set default tech stack for /plan"),
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
      const cfg = await withStateLock(projectRoot, () => withLock(configPath(projectRoot), async () => {
        const innerCfg = await readConfigWithRestore(projectRoot)
        if (args.defaultTechStack !== undefined) {
          innerCfg.defaultTechStack = args.defaultTechStack ?? null
          await writeConfigWithBackup(projectRoot, innerCfg)
        } else if (args.key && args.value !== undefined) {
          if (args.key === "expressMode") {
            innerCfg.expressMode = args.value === "true"
          } else if (args.key === "autoVersioning") {
            innerCfg.autoVersioning = args.value === "true"
          } else if (args.key === "defaultTechStack") {
            innerCfg.defaultTechStack = args.value ?? null
          } else {
            innerCfg.preferences[args.key] = args.value
          }
          innerCfg.lastUsedLanguage = args.key === "language" ? args.value : innerCfg.lastUsedLanguage
          await writeConfigWithBackup(projectRoot, innerCfg)
        }
        return innerCfg
      }))

      if (args.defaultTechStack !== undefined) {
        return {
          title: "Configuration updated",
          output: `defaultTechStack: ${cfg.defaultTechStack ?? "(not set)"}`,
          metadata: cfg,
        }
      }

      if (args.key && args.value !== undefined) {
        return {
          title: "Configuration updated",
          output: `${args.key}: ${args.value}`,
          metadata: cfg,
        }
      }

      if (args.key) {
        const knownKeys: Record<string, string | null> = {
          defaultTechStack: cfg.defaultTechStack,
          lastUsedLanguage: cfg.lastUsedLanguage,
          expressMode: String(cfg.expressMode),
          autoVersioning: String(cfg.autoVersioning),
        }
        if (args.key === "expressMode") {
          return {
            title: "Configuration read",
            output: `expressMode: ${cfg.expressMode}`,
            metadata: cfg,
          }
        }
        if (args.key === "autoVersioning") {
          return {
            title: "Configuration read",
            output: `autoVersioning: ${cfg.autoVersioning}`,
            metadata: cfg,
          }
        }
        if (args.key === "defaultTechStack") {
          return {
            title: "Configuration read",
            output: `defaultTechStack: ${cfg.defaultTechStack ?? "(not set)"}`,
            metadata: cfg,
          }
        }
        const raw = cfg.preferences[args.key] ?? knownKeys[args.key]
        return {
          title: "Configuration read",
          output: `${args.key}: ${raw ?? "(not set)"}`,
          metadata: cfg,
        }
      }

      const lines = [
        `defaultTechStack: ${cfg.defaultTechStack ?? "(not set)"}`,
        `lastUsedLanguage: ${cfg.lastUsedLanguage ?? "(not set)"}`,
        `expressMode: ${cfg.expressMode}`,
        `autoVersioning: ${cfg.autoVersioning}`,
        `preferences: ${Object.keys(cfg.preferences).length} key(s)`,
      ]

      return {
        title: "SDD Configuration",
        output: lines.join(" | "),
        metadata: cfg,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `config: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
