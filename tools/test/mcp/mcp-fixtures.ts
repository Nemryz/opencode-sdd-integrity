import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(HERE, "..", "..", "..")
export const FIXTURE_DIR = path.join(REPO_ROOT, "tools", "test", "fixtures", "v1-migration")
export const MCP_MATRIX_PATH = path.join(HERE, "mcp-matrix.json")
export const RAW_CONFIG_PATH = path.join(FIXTURE_DIR, "opencode.jsonc")
export const EXPECTED_CONFIG_PATH = path.join(FIXTURE_DIR, "opencode.expected.jsonc")

export const EXPECTED_TOOL_IDS = [
  "approve",
  "archive",
  "audit",
  "clean",
  "complexity",
  "config",
  "delta",
  "evidence",
  "guard",
  "health",
  "lab",
  "mutation",
  "perf",
  "phase",
  "scaffold",
  "selfheal",
  "snapshot",
  "status",
  "validate",
]

export const EXPECTED_SHIM_IDS = [
  "doom-loop",
  "events",
  "guard",
  "perfmon",
  "tools",
]

export type McpServer = {
  type: "local" | "remote"
  command?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
  cwd?: string
  enabled?: boolean
  timeout?: number
}

export type OpenCodeConfig = {
  mcp: Record<string, McpServer>
  tools?: Record<string, boolean>
  agent?: Record<string, { tools?: Record<string, boolean> }>
  agents?: Record<string, { tools?: Record<string, boolean> }>
  plugin?: string[]
}

export type MatrixServer = {
  name: string
  transport: "stdio" | "http"
  timeout?: number
  enabled: boolean
  agents: string[]
  requiredEnv: string[]
}

export type McpMatrix = {
  schemaVersion: number
  servers: MatrixServer[]
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

export function loadMatrix(): McpMatrix {
  return readJson<McpMatrix>(MCP_MATRIX_PATH)
}

export function loadRawConfig(): OpenCodeConfig {
  return readJson<OpenCodeConfig>(RAW_CONFIG_PATH)
}

export function loadExpectedConfig(): OpenCodeConfig {
  return readJson<OpenCodeConfig>(EXPECTED_CONFIG_PATH)
}

export function dedupePluginEntries(config: OpenCodeConfig): OpenCodeConfig {
  if (!Array.isArray(config.plugin)) return { ...config }
  return {
    ...config,
    plugin: config.plugin.filter((entry) => !entry.replace(/\\/g, "/").startsWith("./tools/plugins/speckit-")),
  }
}

export function visibleServers(matrix: McpMatrix, config: OpenCodeConfig, agent: string): string[] {
  return matrix.servers
    .filter((meta) => {
      const server = config.mcp[meta.name]
      if (!server || server.enabled === false) return false
      return meta.agents.includes("*") || meta.agents.includes(agent)
    })
    .map((meta) => meta.name)
}

export function envPlaceholders(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1])
  }
  if (Array.isArray(value)) return value.flatMap(envPlaceholders)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(envPlaceholders)
  }
  return []
}

export function serverPlaceholders(server: McpServer): string[] {
  return [...new Set(envPlaceholders(server))]
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/")
}
