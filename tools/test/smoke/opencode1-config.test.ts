import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { EXPECTED_SHIM_IDS, REPO_ROOT, toPosix } from "../mcp/mcp-fixtures"

const OPENCODE1_BIN = process.env.OPENCODE1_BIN ?? "opencode"
const NODE_MODULES = process.env.OPENCODE1_NODE_MODULES ?? path.join(REPO_ROOT, "node_modules")
const SOURCE_DIR = process.env.OPENCODE1_CONFIG_DIR ?? REPO_ROOT
const TIMEOUT = 120000

function readVersion(): string | null {
  try {
    const output = execFileSync(OPENCODE1_BIN, ["--version"], { encoding: "utf-8", timeout: 15000 })
    return output.trim()
  } catch {
    return null
  }
}

function majorVersion(version: string | null): number | null {
  const match = version?.match(/v?(\d+)\./)
  return match ? Number(match[1]) : null
}

const VERSION = readVersion()
const IS_OPENCODE1 = majorVersion(VERSION) === 1
const HAS_NODE_MODULES = existsSync(NODE_MODULES)

let baseDir = ""
let configDir = ""
let projectDir = ""
let env: NodeJS.ProcessEnv = {}

function parseJsonOutput(output: string): Record<string, unknown> {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error(`opencode debug config did not return JSON: ${output.slice(0, 400)}`)
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
}

function normalizeOrigin(item: unknown): string {
  if (typeof item === "string") {
    const trimmed = item.trim()
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const value = parsed.spec ?? parsed.path ?? parsed.origin ?? parsed.file ?? parsed.id ?? parsed.name
        if (typeof value === "string") return value
      } catch {
        // a plain path that starts with a brace stays unchanged
      }
    }
    return item
  }
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>
    const value = record.spec ?? record.path ?? record.origin ?? record.file ?? record.id ?? record.name
    if (typeof value === "string") return value
  }
  return JSON.stringify(item)
}

function readOrigins(config: Record<string, unknown>): string[] | null {
  const candidates = [
    config.plugin_origins,
    config.pluginOrigins,
    (config.plugin_origins as { origins?: unknown } | undefined)?.origins,
    (config.plugins as { origins?: unknown } | undefined)?.origins,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate.map(normalizeOrigin)
  }
  return null
}

function shimIds(origins: string[]): string[] {
  return origins
    .map((origin) => {
      const normalized = toPosix(origin)
      if (/\/tools\/plugins\/speckit-/.test(normalized)) return ""
      return normalized.match(/\/plugins\/speckit-(doom-loop|events|guard|perfmon|tools)\.ts$/)?.[1] ?? ""
    })
    .filter(Boolean)
    .sort()
}

function toolsPluginOrigins(origins: string[]): string[] {
  return origins.filter((origin) => /\/tools\/plugins\/speckit-/.test(toPosix(origin)))
}

function runDebugConfig(): { config: Record<string, unknown>; stdout: string; stderr: string } {
  const result = spawnSync(OPENCODE1_BIN, ["debug", "config"], {
    cwd: projectDir,
    env,
    encoding: "utf-8",
    timeout: TIMEOUT,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`opencode debug config exited with ${result.status}: ${stderr.slice(0, 800)}`)
  }
  const output = stdout.trim().length > 0 ? stdout : stderr
  return { config: parseJsonOutput(output), stdout, stderr }
}

async function writeConfig(plugin?: string[]): Promise<void> {
  const config = {
    $schema: "https://opencode.ai/config.json",
    agent: { spec: {} },
    ...(plugin ? { plugin } : {}),
  }
  await fs.writeFile(path.join(configDir, "opencode.jsonc"), JSON.stringify(config, null, 2) + "\n")
}

async function setupOpenCode1(): Promise<void> {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-opencode1-"))
  const configHome = path.join(baseDir, "xdg-config")
  const dataHome = path.join(baseDir, "xdg-data")
  const stateHome = path.join(baseDir, "xdg-state")
  const cacheHome = path.join(baseDir, "xdg-cache")
  const home = path.join(baseDir, "home")
  configDir = path.join(configHome, "opencode")
  projectDir = path.join(baseDir, "project")
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(dataHome, { recursive: true })
  await fs.mkdir(stateHome, { recursive: true })
  await fs.mkdir(cacheHome, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(path.join(projectDir, ".opencode", "spec-memory"), { recursive: true })
  await fs.writeFile(path.join(projectDir, "README.md"), "# OpenCode 1 config check\n")
  await fs.cp(path.join(SOURCE_DIR, "plugins"), path.join(configDir, "plugins"), { recursive: true })
  await fs.cp(path.join(SOURCE_DIR, "tools"), path.join(configDir, "tools"), { recursive: true })
  await fs.copyFile(path.join(SOURCE_DIR, "AGENTS.md"), path.join(configDir, "AGENTS.md"))
  await fs.symlink(NODE_MODULES, path.join(configDir, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  await writeConfig()
  env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE1_CONFIG_DIR: configDir,
  }
}

async function cleanupOpenCode1(): Promise<void> {
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true })
}

describe.skipIf(!IS_OPENCODE1 || !HAS_NODE_MODULES)("OpenCode 1 plugin origins", () => {
  beforeAll(setupOpenCode1)
  afterAll(cleanupOpenCode1)

  it("reports the five shipped shims and no tools plugin origins", () => {
    const result = runDebugConfig()
    const origins = readOrigins(result.config)
    if (!origins) {
      throw new Error(`opencode debug config did not expose plugin_origins on ${VERSION ?? OPENCODE1_BIN}`)
    }
    expect(shimIds(origins)).toEqual(EXPECTED_SHIM_IDS)
    expect(toolsPluginOrigins(origins)).toEqual([])
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("failed to load plugin")
  }, TIMEOUT)

  it("adds exactly two origins when the raw local entries are present", async () => {
    const positive = runDebugConfig()
    const positiveOrigins = readOrigins(positive.config)
    if (!positiveOrigins) {
      throw new Error(`opencode debug config did not expose plugin_origins on ${VERSION ?? OPENCODE1_BIN}`)
    }
    await writeConfig(["./tools/plugins/speckit-perfmon.ts", "./tools/plugins/speckit-guard.ts"])
    const negative = runDebugConfig()
    const negativeOrigins = readOrigins(negative.config)
    if (!negativeOrigins) {
      throw new Error(`opencode debug config did not expose plugin_origins on ${VERSION ?? OPENCODE1_BIN}`)
    }
    expect(toolsPluginOrigins(negativeOrigins)).toHaveLength(2)
    expect(negativeOrigins.length).toBe(positiveOrigins.length + 2)
    expect(shimIds(negativeOrigins)).toEqual(EXPECTED_SHIM_IDS)
  }, TIMEOUT)
})
