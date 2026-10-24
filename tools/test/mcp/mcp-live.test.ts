import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import { loadMatrix, type McpServer } from "./mcp-fixtures"
import {
  MissingEnvError,
  assertBaselineOutsideRepo,
  baselinePath,
  isConnectionError,
  loadBaseline,
  probeServer,
  resolveEnv,
  writeBaseline,
  type McpBaseline,
  type ProbeResult,
} from "../helpers/mcp-probe"

const RUN_LIVE = process.env.MCP_LIVE === "1"
const BASELINE_MODE = process.env.MCP_BASELINE_MODE ?? "compare"
const MATRIX = loadMatrix()
const TIMEOUT = 335000

function skipList(): string[] {
  return (process.env.MCP_SKIP ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function loadLiveConfig(): Record<string, McpServer> {
  const file = process.env.MCP_CONFIG
  if (!file) throw new Error("MCP_CONFIG must point to the sanitized live MCP configuration")
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { mcp?: Record<string, McpServer> }
  return parsed.mcp ?? (parsed as unknown as Record<string, McpServer>)
}

const LIVE: Record<string, McpServer> = RUN_LIVE ? loadLiveConfig() : {}
const TESTABLE_SERVERS = MATRIX.servers.filter(
  (meta) => meta.enabled && meta.name !== "firecrawl" && LIVE[meta.name]?.enabled !== false,
)

describe.skipIf(!RUN_LIVE)("MCP live matrix", () => {
  const results: ProbeResult[] = []
  let baseline: McpBaseline | null = null
  let baselineFile = ""
  let ready = false
  let failed = false

  beforeAll(() => {
    if (BASELINE_MODE !== "write" && BASELINE_MODE !== "compare") {
      throw new Error(`MCP_BASELINE_MODE must be write or compare, received ${BASELINE_MODE}`)
    }
    baselineFile = baselinePath()
    assertBaselineOutsideRepo(baselineFile)
    if (BASELINE_MODE === "compare") {
      baseline = loadBaseline(baselineFile)
      if (!baseline) throw new Error(`MCP baseline is missing at ${baselineFile}. Run with MCP_BASELINE_MODE=write first.`)
    }
    ready = true
  })

  afterAll(() => {
    if (!ready || failed || results.length === 0) return
    if (BASELINE_MODE === "write") writeBaseline(baselineFile, results)
  })

  it("contains every required server in MCP_CONFIG", () => {
    const missing = MATRIX.servers.map((meta) => meta.name).filter((name) => !(name in LIVE))
    if (missing.length > 0) failed = true
    expect(missing, `missing servers in MCP_CONFIG: ${missing.join(", ")}`).toEqual([])
  })

  describe.sequential("servers", () => {
    for (const meta of TESTABLE_SERVERS) {
      it(meta.name, async (context) => {
        if (skipList().includes(meta.name)) return context.skip("listed in MCP_SKIP")
        const server = LIVE[meta.name]
        if (!server) {
          failed = true
          throw new Error(`MCP_CONFIG is missing required server ${meta.name}`)
        }
        try {
          resolveEnv(server)
        } catch (error) {
          if (error instanceof MissingEnvError) return context.skip(error.message)
          failed = true
          throw error
        }

        try {
          const result = await probeServer(meta, server)
          expect(result.tools.length, `no tools for ${meta.name}`).toBeGreaterThan(0)
          expect(new Set(result.tools).size, `duplicate tools for ${meta.name}`).toBe(result.tools.length)
          results.push(result)

          if (BASELINE_MODE === "compare") {
            const expected = baseline?.servers[meta.name]
            expect(expected, `missing baseline entry for ${meta.name}`).toBeDefined()
            expect(result.serverName, `server name for ${meta.name}`).toBe(expected?.serverName)
            expect(result.tools, `tools for ${meta.name}`).toEqual(expected?.tools)
          }
        } catch (error) {
          if (error instanceof MissingEnvError) return context.skip(error.message)
          if (meta.name === "anki" && isConnectionError(error)) return context.skip("Anki is not running")
          failed = true
          throw error
        }
      }, TIMEOUT)
    }
  })

  it("probes at least one server", () => {
    if (results.length === 0) failed = true
    expect(results.length, "no MCP server was probed").toBeGreaterThan(0)
  })
})
