import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import { loadMatrix, type McpServer } from "./mcp-fixtures"
import {
  MissingEnvError,
  SkipProbe,
  baselinePath,
  isConnectionError,
  loadBaseline,
  probeServer,
  resolveEnv,
  writeBaseline,
  type ProbeResult,
} from "../helpers/mcp-probe"

const RUN_LIVE = process.env.MCP_LIVE === "1"
const BASELINE_MODE = process.env.MCP_BASELINE_MODE ?? "compare"
const BASELINE_FILE = baselinePath()
const BASELINE = loadBaseline(BASELINE_FILE)
const MATRIX = loadMatrix()
const RESULTS: ProbeResult[] = []
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

let LIVE: Record<string, McpServer> = {}

beforeAll(() => {
  LIVE = loadLiveConfig()
  if (BASELINE_MODE === "compare" && !BASELINE) {
    throw new Error(`MCP baseline is missing at ${BASELINE_FILE}. Run with MCP_BASELINE_MODE=write first.`)
  }
})

afterAll(() => {
  if (BASELINE_MODE === "write" && RESULTS.length > 0) {
    writeBaseline(BASELINE_FILE, RESULTS)
  }
})

describe.skipIf(!RUN_LIVE)("MCP live matrix", () => {
  describe.sequential("servers", () => {
    for (const meta of MATRIX.servers) {
      it(meta.name, async (context) => {
        if (!meta.enabled) return context.skip("disabled in the matrix")
        if (skipList().includes(meta.name)) return context.skip("listed in MCP_SKIP")
        const server = LIVE[meta.name]
        if (!server) return context.skip("not present in MCP_CONFIG")
        try {
          resolveEnv(server)
        } catch (error) {
          if (error instanceof MissingEnvError) return context.skip(error.message)
          throw error
        }

        try {
          const result = await probeServer(meta, server)
          expect(result.tools.length, `no tools for ${meta.name}`).toBeGreaterThan(0)
          expect(new Set(result.tools).size, `duplicate tools for ${meta.name}`).toBe(result.tools.length)
          RESULTS.push(result)

          if (BASELINE_MODE === "compare") {
            const expected = BASELINE?.servers[meta.name]
            expect(expected, `missing baseline entry for ${meta.name}`).toBeDefined()
            expect(result.serverName, `server name for ${meta.name}`).toBe(expected?.serverName)
            expect(result.tools, `tools for ${meta.name}`).toEqual(expected?.tools)
          }
        } catch (error) {
          if (error instanceof MissingEnvError || error instanceof SkipProbe) return context.skip(error.message)
          if (meta.name === "anki" && isConnectionError(error)) return context.skip("Anki is not running")
          throw error
        }
      }, TIMEOUT)
    }
  })
})
