import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { runInstall } from "../../install/installer.mjs"
import { removeDirWithRetry } from "../helpers/setup"
import approveTool from "../../speckit-approve"
import archiveTool from "../../speckit-archive"
import auditTool from "../../speckit-audit"
import cleanTool from "../../speckit-clean"
import complexityTool from "../../speckit-complexity"
import configTool from "../../speckit-config"
import deltaTool from "../../speckit-delta"
import evidenceTool from "../../speckit-evidence"
import guardTool from "../../speckit-guard"
import healthTool from "../../speckit-health"
import labTool from "../../speckit-lab"
import mutationTool from "../../speckit-mutation"
import perfTool from "../../speckit-perf"
import phaseTool from "../../speckit-phase"
import scaffoldTool from "../../speckit-scaffold"
import selfhealTool from "../../speckit-selfheal"
import snapshotTool from "../../speckit-snapshot"
import statusTool from "../../speckit-status"
import validateTool from "../../speckit-validate"
import {
  EXPECTED_SHIM_IDS,
  EXPECTED_TOOL_IDS,
  REPO_ROOT,
  dedupePluginEntries,
  loadExpectedConfig,
  loadMatrix,
  loadRawConfig,
  matchesToolPattern,
  serverPlaceholders,
  visibleServers,
} from "./mcp-fixtures"

const TOOL_MODULES = {
  approve: approveTool,
  archive: archiveTool,
  audit: auditTool,
  clean: cleanTool,
  complexity: complexityTool,
  config: configTool,
  delta: deltaTool,
  evidence: evidenceTool,
  guard: guardTool,
  health: healthTool,
  lab: labTool,
  mutation: mutationTool,
  perf: perfTool,
  phase: phaseTool,
  scaffold: scaffoldTool,
  selfheal: selfhealTool,
  snapshot: snapshotTool,
  status: statusTool,
  validate: validateTool,
}

const EXPECTED_TOOLS = [
  "bootstrap-docs*",
  "classmcp*",
  "kala*",
  "playwright*",
  "serena*",
  "basic-memory*",
  "arxiv*",
  "chrome-devtools*",
  "excalidraw*",
  "firecrawl*",
  "webnovel*",
]

const EXPECTED_AGENT_TOOLS = {
  build: ["bootstrap-docs*", "classmcp*", "kala*", "playwright*", "serena*", "chrome-devtools*", "excalidraw*"],
  spec: ["excalidraw*"],
  novel: ["basic-memory*", "arxiv*", "webnovel*"],
}

describe("MCP fixture and matrix", () => {
  it("keeps the matrix metadata complete for all eighteen servers", () => {
    const matrix = loadMatrix()
    expect(matrix.schemaVersion).toBe(1)
    expect(matrix.servers).toHaveLength(18)
    expect(new Set(matrix.servers.map((server) => server.name)).size).toBe(18)
    expect(matrix.servers.filter((server) => server.enabled)).toHaveLength(17)
    expect(matrix.servers.find((server) => server.name === "firecrawl")?.enabled).toBe(false)
  })

  it("maps every fixture server to the same transport, state, timeout and placeholders", () => {
    const matrix = loadMatrix()
    const config = loadRawConfig()
    expect(Object.keys(config.mcp)).toEqual(matrix.servers.map((server) => server.name))

    for (const meta of matrix.servers) {
      const server = config.mcp[meta.name]
      expect(server, `missing fixture server ${meta.name}`).toBeDefined()
      expect(server.type, `type mismatch for ${meta.name}`).toBe(meta.transport === "stdio" ? "local" : "remote")
      expect(server.enabled, `enabled mismatch for ${meta.name}`).toBe(meta.enabled)
      expect(server.timeout, `timeout mismatch for ${meta.name}`).toBe(meta.timeout)
      expect([...new Set(serverPlaceholders(server))].sort(), `placeholder mismatch for ${meta.name}`).toEqual([...meta.requiredEnv].sort())

      if (meta.transport === "stdio") {
        expect(Array.isArray(server.command), `missing command for ${meta.name}`).toBe(true)
        expect(server.command?.length, `empty command for ${meta.name}`).toBeGreaterThan(0)
        expect(server.command?.every((part) => typeof part === "string" && part.length > 0), `invalid command for ${meta.name}`).toBe(true)
        expect(server.url, `unexpected url for ${meta.name}`).toBeUndefined()
      } else {
        expect(typeof server.url, `missing url for ${meta.name}`).toBe("string")
        expect(() => new URL(server.url ?? ""), `invalid url for ${meta.name}`).not.toThrow()
        expect(server.command, `unexpected command for ${meta.name}`).toBeUndefined()
      }
    }
  })

  it("pins the timeout values from the real configuration", () => {
    const config = loadRawConfig()
    const expected = {
      "bootstrap-docs": 120000,
      classmcp: 60000,
      kala: 60000,
      playwright: 60000,
      exa: 31000,
      memory: 60000,
      "basic-memory": 60000,
      serena: 60000,
      arxiv: 60000,
      "chrome-devtools": 60000,
      excalidraw: 60000,
      firecrawl: 60000,
      vision: 300000,
      webnovel: 60000,
      docgen: 60000,
      unsplash: 60000,
    } as Record<string, number>

    for (const [name, timeout] of Object.entries(expected)) {
      expect(config.mcp[name].timeout, `timeout for ${name}`).toBe(timeout)
    }
    expect(config.mcp.context7.timeout).toBeUndefined()
    expect(config.mcp.anki.timeout).toBeUndefined()
  })

  it("disables eleven wildcard tool families at the top level and leaves only agent scopes", () => {
    const config = loadRawConfig()
    expect(Object.keys(config.tools ?? {})).toEqual(EXPECTED_TOOLS)
    for (const name of EXPECTED_TOOLS) {
      expect(config.tools?.[name], `top level tool ${name}`).toBe(false)
    }
    expect(config.agents).toBeUndefined()
    expect(Object.keys(config.agent ?? {})).toEqual(Object.keys(EXPECTED_AGENT_TOOLS))
    for (const [agent, names] of Object.entries(EXPECTED_AGENT_TOOLS)) {
      expect(Object.keys(config.agent?.[agent].tools ?? {}), `tools for ${agent}`).toEqual(names)
      for (const name of names) {
        expect(config.agent?.[agent].tools?.[name], `${agent} tool ${name}`).toBe(true)
      }
    }
  })

  it("computes the effective visibility for build, spec and novel", () => {
    const config = loadRawConfig()
    expect(visibleServers(config, "build")).toEqual([
      "bootstrap-docs",
      "classmcp",
      "kala",
      "playwright",
      "exa",
      "context7",
      "memory",
      "serena",
      "chrome-devtools",
      "excalidraw",
      "vision",
      "anki",
      "docgen",
      "unsplash",
    ])
    expect(visibleServers(config, "spec")).toEqual([
      "exa",
      "context7",
      "memory",
      "excalidraw",
      "vision",
      "anki",
      "docgen",
      "unsplash",
    ])
    expect(visibleServers(config, "novel")).toEqual([
      "exa",
      "context7",
      "memory",
      "basic-memory",
      "arxiv",
      "vision",
      "webnovel",
      "anki",
      "docgen",
      "unsplash",
    ])
  })

  it("keeps the matrix agent metadata aligned with the fixture", () => {
    const matrix = loadMatrix()
    const config = loadRawConfig()
    const agents = ["build", "spec", "novel"]
    for (const meta of matrix.servers) {
      for (const agent of agents) {
        const visible = visibleServers(config, agent).includes(meta.name)
        const expected = meta.enabled && (meta.agents.includes("*") || meta.agents.includes(agent))
        expect(visible, `${meta.name} for ${agent}`).toBe(expected)
      }
    }
  })

  it("uses a wildcard pattern for every restricted tool family", () => {
    const config = loadRawConfig()
    const patterns = [
      ...Object.keys(config.tools ?? {}),
      ...Object.values(config.agent ?? {}).flatMap((agent) => Object.keys(agent.tools ?? {})),
    ]
    for (const pattern of patterns) {
      expect(pattern.endsWith("*"), `${pattern} must end with a wildcard`).toBe(true)
      expect(config.mcp[pattern.slice(0, -1)], `${pattern} must name a configured server`).toBeDefined()
    }
  })

  it("matches the wildcard tool syntax", () => {
    expect(matchesToolPattern("server*", "server_tool")).toBe(true)
    expect(matchesToolPattern("server_*", "server_tool")).toBe(true)
    expect(matchesToolPattern("server_tool", "server_tool")).toBe(true)
    expect(matchesToolPattern("server", "server_tool")).toBe(false)
    expect(matchesToolPattern("server.tool*", "server.tool_search")).toBe(true)
    expect(matchesToolPattern("server.tool*", "serverXtool_search")).toBe(false)
    expect(matchesToolPattern("server?tool", "server?tool")).toBe(true)
    expect(matchesToolPattern("server?tool", "server_tool")).toBe(false)
  })

  it("dedupes only the four local plugin entries and keeps the two npm entries", () => {
    const raw = loadRawConfig()
    const expected = loadExpectedConfig()
    expect(raw.plugin).toEqual([
      "@codingskuy/coding-school",
      "./tools/plugins/speckit-perfmon.ts",
      "opencode-engram-learning",
      "./tools/plugins/speckit-guard.ts",
    ])
    expect(expected.plugin).toEqual(["@codingskuy/coding-school", "opencode-engram-learning"])
    expect(dedupePluginEntries(raw)).toEqual(expected)
    expect(expected.plugin?.some((entry) => entry.includes("./tools/plugins/speckit-"))).toBe(false)
  })

  it("keeps the raw fixture free of engram_update and real user paths", async () => {
    const raw = await fs.readFile(path.join(REPO_ROOT, "tools", "test", "fixtures", "v1-migration", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain("engram_update")
    expect(raw).not.toMatch(/[A-Za-z]:\\\\/)
    expect(raw).not.toContain("/home/")
    expect(raw.endsWith("\n")).toBe(true)
  })

  it("exposes exactly the nineteen tools with description, args and execute", () => {
    const entries = Object.entries(TOOL_MODULES).sort(([left], [right]) => left.localeCompare(right))
    expect(entries.map(([id]) => id)).toEqual(EXPECTED_TOOL_IDS)
    for (const [id, tool] of entries) {
      const candidate = tool as unknown as Record<string, unknown>
      expect(typeof candidate.description, `description for ${id}`).toBe("string")
      expect((candidate.description as string).length, `empty description for ${id}`).toBeGreaterThan(0)
      expect(candidate.args, `args for ${id}`).toBeDefined()
      expect(typeof candidate.execute, `execute for ${id}`).toBe("function")
      expect(candidate.server, `server for ${id}`).toBeUndefined()
      expect(candidate.setup, `setup for ${id}`).toBeUndefined()
    }
  })

  it("ships the five OpenCode plugin shims", async () => {
    const entries = await fs.readdir(path.join(REPO_ROOT, "plugins"))
    const ids = entries
      .filter((entry) => /^speckit-.+\.ts$/.test(entry))
      .map((entry) => entry.replace(/^speckit-/, "").replace(/\.ts$/, ""))
      .sort()
    expect(ids).toEqual(EXPECTED_SHIM_IDS)
  })

  it("keeps opencode.jsonc byte identical through the installer", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-mcp-config-"))
    const configPath = path.join(target, "opencode.jsonc")
    const raw = await fs.readFile(path.join(REPO_ROOT, "tools", "test", "fixtures", "v1-migration", "opencode.jsonc"))
    const expected = loadRawConfig()
    try {
      await fs.writeFile(configPath, raw)
      const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
      expect(result.verification.ok).toBe(true)
      expect(await fs.readFile(configPath)).toEqual(raw)
      const installed = JSON.parse(await fs.readFile(configPath, "utf-8"))
      expect(installed.mcp).toEqual(expected.mcp)
      expect(installed.tools).toEqual(expected.tools)
      expect(installed.agent).toEqual(expected.agent)
    } finally {
      await removeDirWithRetry(target)
    }
  })
})
