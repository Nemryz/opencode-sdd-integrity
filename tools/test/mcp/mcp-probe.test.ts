import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { removeDirWithRetry } from "../helpers/setup"
import { REPO_ROOT } from "./mcp-fixtures"
import {
  MissingEnvError,
  assertBaselineOutsideRepo,
  baselinePath,
  loadBaseline,
  resolveEnv,
  writeBaseline,
} from "../helpers/mcp-probe"

const tempDirs: string[] = []

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeDirWithRetry(dir)))
})

describe("MCP probe helpers", () => {
  it("defaults the baseline outside the repository", () => {
    const savedPath = process.env.MCP_BASELINE_PATH
    const savedAlias = process.env.MCP_BASELINE
    delete process.env.MCP_BASELINE_PATH
    process.env.MCP_BASELINE = path.join(REPO_ROOT, "reports", "ignored.json")
    try {
      expect(baselinePath()).toBe(path.join(os.homedir(), ".opencode", "mcp-baseline.json"))
    } finally {
      restoreEnv("MCP_BASELINE_PATH", savedPath)
      restoreEnv("MCP_BASELINE", savedAlias)
    }
  })

  it("accepts the explicit path and rejects a repository path", () => {
    const savedPath = process.env.MCP_BASELINE_PATH
    const explicit = path.join(os.homedir(), ".opencode", "custom-baseline.json")
    process.env.MCP_BASELINE_PATH = explicit
    try {
      expect(baselinePath()).toBe(explicit)
    } finally {
      restoreEnv("MCP_BASELINE_PATH", savedPath)
    }
    expect(() => assertBaselineOutsideRepo(path.join(REPO_ROOT, "reports", "mcp-baseline.json"))).toThrow(
      /outside the repository/,
    )
    expect(() => assertBaselineOutsideRepo(path.join(REPO_ROOT, "..", "mcp-baseline.json"))).not.toThrow()
  })

  it("resolves nested env placeholders and reports the missing name", () => {
    const resolved = resolveEnv(
      { command: ["{env:FAKE_BIN}", "run"], cwd: "{env:FAKE_DIR}" },
      { FAKE_BIN: "/bin/echo", FAKE_DIR: "/tmp/work" },
    )
    expect(resolved).toEqual({ command: ["/bin/echo", "run"], cwd: "/tmp/work" })
    expect(() => resolveEnv("{env:FAKE_MISSING}", {})).toThrow(MissingEnvError)
  })

  it("round trips the baseline through a temp directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-baseline-"))
    tempDirs.push(dir)
    const file = path.join(dir, "mcp-baseline.json")
    const result = { name: "classmcp", serverName: "fake", serverVersion: "1.0.0", tools: ["fake_tool"] }
    writeBaseline(file, [result])
    expect(loadBaseline(file)).toEqual({ servers: { classmcp: result } })
  })

  it("returns null for a missing baseline and throws for invalid JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-baseline-"))
    tempDirs.push(dir)
    expect(loadBaseline(path.join(dir, "missing.json"))).toBeNull()
    const invalid = path.join(dir, "invalid.json")
    await fs.writeFile(invalid, "{")
    expect(() => loadBaseline(invalid)).toThrow()
  })
})
