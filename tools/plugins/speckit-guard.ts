import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { withLock, writeWithBackup, markPluginLoaded, stripBom } from "../shared/io"
import { pickProjectRoot } from "../shared/types"

export const GuardConfigSchema = z.object({
  version: z.number(),
  enabled: z.boolean(),
  debug: z.boolean(),
  protectedFiles: z.array(z.string()),
  protectedAfterApproval: z.array(z.string()),
  protectedByPhase: z.record(z.string(), z.array(z.string())),
  stats: z.object({
    denied: z.number(),
    allowed: z.number(),
    asked: z.number(),
  }),
  denials: z.array(z.object({
    timestamp: z.string(),
    file: z.string(),
    reason: z.string(),
  })),
})

export type GuardConfig = z.infer<typeof GuardConfigSchema>

type SpecJson = {
  phase: string
  approvals: {
    spec: { generated: boolean; approved: boolean }
    plan: { generated: boolean; approved: boolean }
    tasks: { generated: boolean; approved: boolean }
  }
}

export const DEFAULT_CONFIG: GuardConfig = {
  version: 1,
  enabled: true,
  debug: false,
  protectedFiles: [
    ".opencode/spec-memory/constitution.md",
    ".opencode/spec-memory/session.json",
    ".opencode/spec-memory/config.json",
    ".opencode/guard.json",
    "spec.json",
  ],
  protectedAfterApproval: ["spec.json", "spec.md", "plan.md", "tasks.md"],
  protectedByPhase: {
    tasks: ["plan.md"],
    ready: ["plan.md", "tasks.md"],
    impl: ["plan.md", "tasks.md"],
    complete: ["plan.md", "tasks.md", "spec.md", "spec.json"],
  },
  stats: { denied: 0, allowed: 0, asked: 0 },
  denials: [],
}

const MAX_DENIALS_LOG = 10

const CONSTITUTION_PLACEHOLDERS = [
  "[PROJECT NAME]",
  "[add project-specific constraints]",
  "[describe testing tools / patterns]",
  "[document configuration approach]",
  "[document integration test setup]",
  "[list lint/format/type-check tools]",
  "[document any doc conventions]",
]

export function isDraftConstitution(content: string): boolean {
  for (const placeholder of CONSTITUTION_PLACEHOLDERS) {
    if (content.includes(placeholder)) return true
  }
  return false
}

export function cloneConfig(config: GuardConfig): GuardConfig {
  return {
    ...config,
    protectedFiles: [...config.protectedFiles],
    protectedAfterApproval: [...config.protectedAfterApproval],
    protectedByPhase: Object.fromEntries(
      Object.entries(config.protectedByPhase).map(([phase, files]) => [phase, [...files]]),
    ),
    stats: { ...config.stats },
    denials: config.denials.map(d => ({ ...d })),
  }
}

const FILE_TOOLS = ["write", "edit", "apply_patch", "patch"]
const SHELL_TOOLS = ["bash", "shell"]

export function normalizeGuardPath(p: string): string {
  const unified = p.replace(/\\/g, "/")
  return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified
}

export function guardBasename(p: string): string {
  const unified = p.replace(/\\/g, "/")
  const idx = unified.lastIndexOf("/")
  return idx >= 0 ? unified.slice(idx + 1) : unified
}

export function isProtectedFile(filePath: string, config: GuardConfig): string | null {
  const normalized = normalizeGuardPath(filePath)
  const base = guardBasename(normalized)
  for (const pattern of config.protectedFiles) {
    const normalizedPattern = normalizeGuardPath(pattern)
    if (normalized.endsWith(normalizedPattern) || base === guardBasename(normalizedPattern)) {
      return `Always protected: ${pattern}`
    }
  }
  return null
}

export function isProtectedAfterApproval(filePath: string, config: GuardConfig): string | null {
  const base = guardBasename(normalizeGuardPath(filePath))
  if (config.protectedAfterApproval.some(f => normalizeGuardPath(f) === base)) {
    return `Protected after approval: ${base}`
  }
  return null
}

export async function getSpecJson(filePath: string, worktree: string): Promise<SpecJson | null> {
  const featureDir = path.dirname(filePath)
  const specJsonPath = path.join(featureDir, "spec.json")
  try {
    const content = await fs.readFile(specJsonPath, "utf-8")
    return JSON.parse(stripBom(content))
  } catch {
    return null
  }
}

export function isApprovedForFile(basename: string, spec: SpecJson): boolean {
  const base = normalizeGuardPath(basename)
  if (base === "spec.json" || base === "spec.md") return spec.approvals?.spec?.approved ?? false
  if (base === "plan.md") return spec.approvals?.plan?.approved ?? false
  if (base === "tasks.md") return spec.approvals?.tasks?.approved ?? false
  return false
}

export function isProtectedByPhase(filePath: string, phase: string, config: GuardConfig): string | null {
  const base = guardBasename(normalizeGuardPath(filePath))
  const protectedInPhase = config.protectedByPhase[phase]
  if (protectedInPhase && protectedInPhase.some(f => normalizeGuardPath(f) === base)) {
    return `Protected in ${phase} phase: ${base}`
  }
  return null
}

export function isListedInAnyPhase(filePath: string, config: GuardConfig): boolean {
  const base = guardBasename(normalizeGuardPath(filePath))
  return Object.values(config.protectedByPhase).some(list => list.some(f => normalizeGuardPath(f) === base))
}

export function isInFeatureDir(filePath: string): boolean {
  return /(^|\/)specs\//.test(normalizeGuardPath(filePath))
}

export function extractRedirectTargets(command: string): string[] {
  const targets: string[] = []
  const stripQuotes = (s: string) => s.replace(/^["']|["']$/g, "")
  const redirectRe = />>?\s*("[^"]+"|'[^']+'|[^\s"'`;|&<>()]+)/g
  const teeRe = /\btee\b(?:\s+-a)?\s+("[^"]+"|'[^']+'|[^\s"'`;|&<>()]+)/g
  let match: RegExpExecArray | null
  while ((match = redirectRe.exec(command)) !== null) {
    targets.push(stripQuotes(match[1]))
  }
  while ((match = teeRe.exec(command)) !== null) {
    targets.push(stripQuotes(match[1]))
  }
  return targets
}

export function addDenial(config: GuardConfig, file: string, reason: string): void {
  config.denials.unshift({
    timestamp: new Date().toISOString(),
    file,
    reason,
  })
  if (config.denials.length > MAX_DENIALS_LOG) {
    config.denials = config.denials.slice(0, MAX_DENIALS_LOG)
  }
}

type GuardOps = {
  readConfig: () => Promise<GuardConfig>
  writeConfig: (config: GuardConfig) => Promise<void>
  evaluatePath: (rawPath: string, config: GuardConfig) => Promise<string | null>
  recordDenial: (config: GuardConfig, displayPath: string, reason: string, label: "DENIED" | "BLOCKED") => Promise<void>
}

// Binds the guard state helpers to one project root so both runtimes share the same logic.
async function createGuardOps(projectRoot: string): Promise<GuardOps> {
  const configPath = path.join(projectRoot, ".opencode", "guard.json")
  await markPluginLoaded(projectRoot, "speckit-guard")

  async function readConfig(): Promise<GuardConfig> {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(stripBom(await fs.readFile(configPath, "utf-8")))
    } catch {
      return cloneConfig(DEFAULT_CONFIG)
    }
    const result = GuardConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...(parsed as object) })
    return result.success ? result.data : cloneConfig(DEFAULT_CONFIG)
  }

  async function writeConfig(config: GuardConfig): Promise<void> {
    const result = GuardConfigSchema.safeParse(config)
    if (!result.success) return
    await withLock(configPath, async () => {
      await writeWithBackup(configPath, JSON.stringify(result.data, null, 2), projectRoot)
    })
  }

  async function normalizePath(filePath: string): Promise<string> {
    let resolved = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath)
    try {
      resolved = await fs.realpath(resolved)
    } catch {
      // file may not exist yet, fall back to the resolved path
    }
    return resolved
  }

  async function evaluatePath(rawPath: string, config: GuardConfig): Promise<string | null> {
    const normalized = await normalizePath(rawPath)

    const alwaysProtected = isProtectedFile(normalized, config)
    if (alwaysProtected) {
      if (normalizeGuardPath(guardBasename(normalized)) === "constitution.md") {
        try {
          const content = await fs.readFile(normalized, "utf-8")
          if (isDraftConstitution(content)) return null
        } catch {
          // unreadable constitution stays protected (fail closed)
        }
      }
      return alwaysProtected
    }

    const spec = await getSpecJson(normalized, projectRoot)
    const inFeatureDir = isInFeatureDir(normalized)

    const afterApproval = inFeatureDir ? isProtectedAfterApproval(normalized, config) : null
    if (afterApproval) {
      if (!spec) return `${afterApproval} (spec.json unreadable, denied as a precaution)`
      if (isApprovedForFile(guardBasename(normalized), spec)) return `${afterApproval} (approved)`
    }

    if (!spec) {
      if (inFeatureDir && isListedInAnyPhase(normalized, config)) {
        return "Phase-protected file with unreadable spec.json, denied as a precaution"
      }
      return null
    }

    return isProtectedByPhase(normalized, spec.phase, config)
  }

  async function recordDenial(config: GuardConfig, displayPath: string, reason: string, label: "DENIED" | "BLOCKED"): Promise<void> {
    config.stats.denied++
    addDenial(config, displayPath, reason)
    if (config.debug) {
      console.log(`[Guard] ${label}: ${displayPath} - ${reason}`)
    }
    await writeConfig(config)
  }

  return { readConfig, writeConfig, evaluatePath, recordDenial }
}

async function blockPath(ops: GuardOps, config: GuardConfig, displayPath: string, reason: string): Promise<never> {
  await ops.recordDenial(config, displayPath, reason, "BLOCKED")
  throw new Error(`Guard blocked protected file: ${displayPath} (${reason})`)
}

// Inspects one tool call before execution, throwing when a protected path or shell redirect target is touched.
async function inspectToolCall(ops: GuardOps, tool: string, args: Record<string, unknown>, shellTools: string[]): Promise<void> {
  const config = await ops.readConfig()
  if (!config.enabled) return

  if (FILE_TOOLS.includes(tool)) {
    const rawPath = args.filePath ?? args.path
    if (typeof rawPath !== "string" || rawPath.length === 0) return
    const reason = await ops.evaluatePath(rawPath, config)
    if (reason) await blockPath(ops, config, rawPath, reason)
    return
  }

  if (shellTools.includes(tool)) {
    const command = typeof args.command === "string" ? args.command : ""
    for (const target of extractRedirectTargets(command)) {
      const reason = await ops.evaluatePath(target, config)
      if (reason) await blockPath(ops, config, target, `shell redirect target: ${reason}`)
    }
  }
}

const guardPlugin: V1Plugin = async (input) => {
  const projectRoot = pickProjectRoot(input) ?? input.worktree
  const ops = await createGuardOps(projectRoot)

  return {
    "tool.execute.before": async (toolInput, toolOutput) => {
      const args = (toolOutput?.args ?? {}) as Record<string, unknown>
      await inspectToolCall(ops, toolInput?.tool, args, ["bash"])
    },

    "permission.ask": async (permission, output) => {
      const config = await ops.readConfig()
      if (!config.enabled) return

      const patterns = permission.pattern
        ? Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern]
        : []
      if (patterns.length === 0) return

      if (permission.type === "edit") {
        config.stats.asked++
        const reason = await ops.evaluatePath(patterns[0], config)
        if (reason) {
          output.status = "deny"
          await ops.recordDenial(config, patterns[0], reason, "DENIED")
          return
        }
      } else if (permission.type === "bash") {
        config.stats.asked++
        for (const command of patterns) {
          for (const target of extractRedirectTargets(command)) {
            const reason = await ops.evaluatePath(target, config)
            if (reason) {
              output.status = "deny"
              await ops.recordDenial(config, target, `shell redirect target: ${reason}`, "DENIED")
              return
            }
          }
        }
      } else {
        return
      }

      config.stats.allowed++
      if (config.debug) {
        console.log(`[Guard] ALLOWED: ${permission.type}`)
      }
      await ops.writeConfig(config)
    },
  }
}

export default {
  id: "speckit-guard",
  async setup(ctx: V2Plugin.Context): Promise<void> {
    const projectRoot = ctx.location.project.canonical
    const ops = await createGuardOps(projectRoot)

    await ctx.tool.hook("execute.before", async (event) => {
      const args = (event.input ?? {}) as Record<string, unknown>
      await inspectToolCall(ops, event.tool, args, SHELL_TOOLS)
    })

    await ctx.permission.hook("evaluate", async (event) => {
      const config = await ops.readConfig()
      if (!config.enabled) return

      const resources = event.resources ?? []
      if (resources.length === 0) return

      if (event.action === "edit") {
        config.stats.asked++
        for (const resource of resources) {
          const reason = await ops.evaluatePath(resource, config)
          if (reason) {
            event.effect = "deny"
            event.message = reason
            await ops.recordDenial(config, resource, reason, "DENIED")
            return
          }
        }
      } else if (event.action === "shell") {
        config.stats.asked++
        for (const command of resources) {
          for (const target of extractRedirectTargets(command)) {
            const reason = await ops.evaluatePath(target, config)
            if (reason) {
              event.effect = "deny"
              event.message = reason
              await ops.recordDenial(config, target, `shell redirect target: ${reason}`, "DENIED")
              return
            }
          }
        }
      } else {
        return
      }

      config.stats.allowed++
      if (config.debug) {
        console.log(`[Guard] ALLOWED: ${event.action}`)
      }
      await ops.writeConfig(config)
    })
  },
  server: guardPlugin,
}
