import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { runInstall, restoreBackup } from "../../install/installer.mjs"
import guardPlugin, { DEFAULT_CONFIG } from "../../plugins/speckit-guard"
import perfTool from "../../speckit-perf"
import statusTool from "../../speckit-status"
import { mockContext, removeDirWithRetry, repoRootDir } from "../helpers/setup"
import {
  EXPECTED_SHIM_IDS,
  EXPECTED_TOOL_IDS,
  FIXTURE_DIR,
  dedupePluginEntries,
  loadExpectedConfig,
  loadRawConfig,
} from "../mcp/mcp-fixtures"

const REPO_ROOT = repoRootDir()
const SMUDGE = path.join(FIXTURE_DIR, "local-smudge.mjs")
const LOCAL_BLOCK = path.join(FIXTURE_DIR, "local-block.md")
const RAW_CONFIG = path.join(FIXTURE_DIR, "opencode.jsonc")
const AGENTS_LOCAL = path.join(FIXTURE_DIR, "AGENTS.local.md")

const tempDirs: string[] = []

async function makeTarget(): Promise<string> {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-migration-"))
  tempDirs.push(target)
  await fs.writeFile(path.join(target, "opencode.jsonc"), await fs.readFile(RAW_CONFIG))
  await fs.writeFile(path.join(target, "AGENTS.md"), await fs.readFile(AGENTS_LOCAL))
  await fs.writeFile(path.join(target, ".env"), "SENTINEL_ENV=keep\n")
  await fs.writeFile(path.join(target, "memory.db"), "SENTINEL_MEMORY\n")
  await fs.mkdir(path.join(target, "mcp-servers"), { recursive: true })
  await fs.writeFile(path.join(target, "mcp-servers", "sentinel.txt"), "SENTINEL_MCP\n")
  await fs.mkdir(path.join(target, "steering"), { recursive: true })
  await fs.writeFile(path.join(target, "steering", "notes.md"), "# Local Steering\n")
  await fs.mkdir(path.join(target, ".opencode", "spec-memory"), { recursive: true })
  await fs.writeFile(path.join(target, ".opencode", "spec-memory", "constitution.md"), "# Local Constitution\n")
  await fs.writeFile(path.join(target, ".opencode", "spec-memory", "config.json"), JSON.stringify({
    defaultTechStack: "local",
    lastUsedLanguage: "es",
    expressMode: false,
    autoVersioning: false,
    preferences: {},
  }, null, 2))
  await fs.writeFile(path.join(target, ".opencode", "spec-memory", "session.json"), JSON.stringify({
    command: "/status",
    phase: "impl",
    featureDir: "003-migration",
    featureNumber: 3,
    featureName: "migration",
    nextStep: "/impl",
    lastResult: "local",
    history: ["/spec", "/status"],
  }, null, 2))
  await fs.writeFile(path.join(target, ".opencode", "perf.json"), JSON.stringify({
    lastUpdated: "2026-01-01T00:00:00.000Z",
    stats: [{
      tool: "speckit-status",
      calls: 2,
      totalTime: 100,
      times: [50, 50],
      p50: 50,
      p95: 50,
      p99: 50,
      avg: 50,
    }],
  }, null, 2))
  await fs.writeFile(path.join(target, ".opencode", "plugins-state.json"), JSON.stringify({ "speckit-guard": true }, null, 2))
  const guardV1 = {
    ...DEFAULT_CONFIG,
    version: 1,
    protectedFiles: DEFAULT_CONFIG.protectedFiles.filter((entry) => entry !== "evidence.json"),
  }
  await fs.writeFile(path.join(target, ".opencode", "guard.json"), JSON.stringify(guardV1, null, 2))
  const feature = path.join(target, "specs", "003-migration")
  await fs.mkdir(feature, { recursive: true })
  await fs.writeFile(path.join(feature, "spec.md"), "# Migration Spec\n")
  await fs.writeFile(path.join(feature, "plan.md"), "# Migration Plan\n")
  await fs.writeFile(path.join(feature, "tasks.md"), "# Migration Tasks\n")
  await fs.writeFile(path.join(feature, "spec.json"), JSON.stringify({
    feature_name: "migration",
    feature_number: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    phase: "impl",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    ready_for_implementation: true,
  }, null, 2))
  return target
}

async function readBytes(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeDirWithRetry(dir)))
})

describe("V1 to V2 migration", () => {
  it("preserves opencode.jsonc byte for byte and keeps mcp, tools and agent deep equal", async () => {
    const target = await makeTarget()
    const configPath = path.join(target, "opencode.jsonc")
    const before = await readBytes(configPath)
    const raw = loadRawConfig()
    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const after = await readBytes(configPath)
    expect(result.verification.ok).toBe(true)
    expect(after).toEqual(before)
    const installed = JSON.parse(after.toString("utf-8"))
    expect(installed.mcp).toEqual(raw.mcp)
    expect(installed.tools).toEqual(raw.tools)
    expect(installed.agent).toEqual(raw.agent)
    expect(dedupePluginEntries(installed)).toEqual(loadExpectedConfig())
  })

  it("preserves local state outside the install surface", async () => {
    const target = await makeTarget()
    const sentinels = [
      ".env",
      "memory.db",
      "mcp-servers/sentinel.txt",
      "steering/notes.md",
      ".opencode/spec-memory/constitution.md",
      ".opencode/spec-memory/config.json",
      ".opencode/spec-memory/session.json",
      ".opencode/perf.json",
      ".opencode/plugins-state.json",
      ".opencode/guard.json",
      "specs/003-migration/spec.md",
      "specs/003-migration/plan.md",
      "specs/003-migration/tasks.md",
      "specs/003-migration/spec.json",
    ]
    const before = new Map<string, Buffer>()
    for (const relPath of sentinels) {
      before.set(relPath, await readBytes(path.join(target, ...relPath.split("/"))))
    }
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    for (const relPath of sentinels) {
      expect(await readBytes(path.join(target, ...relPath.split("/"))), relPath).toEqual(before.get(relPath))
    }
  })

  it("replaces AGENTS.md with V2, backs up the local block and restores the original", async () => {
    const target = await makeTarget()
    const agentsPath = path.join(target, "AGENTS.md")
    const original = await readBytes(agentsPath)
    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    expect(result.backupDir).not.toBeNull()
    const current = await fs.readFile(agentsPath, "utf-8")
    const expectedV2 = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf-8")
    expect(current).toBe(expectedV2)
    expect(current).not.toContain("V1_ONLY")
    const backupAgents = await fs.readFile(path.join(result.backupDir ?? "", "AGENTS.md"), "utf-8")
    expect(backupAgents).toContain("V1_ONLY")
    expect(backupAgents).toContain("LOCAL_ONLY")
    const restored = await restoreBackup(target, path.basename(result.backupDir ?? ""))
    expect(restored.restored).toBe(path.basename(result.backupDir ?? ""))
    expect(await readBytes(agentsPath)).toEqual(original)
  })

  it("smudges one local block after the V2 overwrite", async () => {
    const v2 = await fs.readFile(path.join(FIXTURE_DIR, "AGENTS.v2.md"), "utf-8")
    const smudged = execFileSync(process.execPath, [SMUDGE], {
      input: v2,
      encoding: "utf-8",
      env: { ...process.env, LOCAL_BLOCK_FILE: LOCAL_BLOCK },
    })
    expect(smudged).toContain("V2_ONLY")
    expect(smudged).not.toContain("V1_ONLY")
    expect(smudged.match(/<!-- local:start -->/g)).toHaveLength(1)
    expect(smudged.match(/LOCAL_ONLY/g)).toHaveLength(1)
  })

  it("migrates guard.json lazily only after a denied edit", async () => {
    const target = await makeTarget()
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const guardPath = path.join(target, ".opencode", "guard.json")
    expect(JSON.parse(await fs.readFile(guardPath, "utf-8")).version).toBe(1)
    const server = await guardPlugin.server({ worktree: target } as never)
    expect(JSON.parse(await fs.readFile(guardPath, "utf-8")).version).toBe(1)
    const evidencePath = path.join(target, "evidence.json")
    const output = { status: "allow" }
    await server["permission.ask"]!(
      { type: "edit", pattern: [evidencePath] } as never,
      output,
    )
    expect(output.status).toBe("deny")
    const persisted = JSON.parse(await fs.readFile(guardPath, "utf-8"))
    expect(persisted.version).toBe(2)
    expect(persisted.protectedFiles).toContain("evidence.json")
    expect(persisted.denials[0].file).toContain("evidence.json")
  })

  it("runs perf and status against the installed worktree", async () => {
    const target = await makeTarget()
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const ctx = mockContext(target)
    const perf = await perfTool.execute({ subcommand: "top 1" }, ctx)
    expect(perf.output).toContain("speckit-status")
    const status = await statusTool.execute({}, ctx)
    expect(status.output).toContain("003-migration")
    expect(status.output).toContain("impl")
  })

  it("ships nineteen tools and five shims into the target", async () => {
    const target = await makeTarget()
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const tools = (await fs.readdir(path.join(target, "tools")))
      .filter((entry) => /^speckit-.+\.ts$/.test(entry))
      .map((entry) => entry.replace(/^speckit-/, "").replace(/\.ts$/, ""))
      .sort()
    const shims = (await fs.readdir(path.join(target, "plugins")))
      .filter((entry) => /^speckit-.+\.ts$/.test(entry))
      .map((entry) => entry.replace(/^speckit-/, "").replace(/\.ts$/, ""))
      .sort()
    expect(tools).toEqual(EXPECTED_TOOL_IDS)
    expect(shims).toEqual(EXPECTED_SHIM_IDS)
  })

  it("installs the current V2 package version", async () => {
    const target = await makeTarget()
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const repoPackage = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf-8"))
    const installedPackage = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"))
    expect(installedPackage.version).toBe(repoPackage.version)
  })

  it("keeps the config and backup stable across a second install", async () => {
    const target = await makeTarget()
    const configPath = path.join(target, "opencode.jsonc")
    const before = await readBytes(configPath)
    const first = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    const second = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    expect(await readBytes(configPath)).toEqual(before)
    expect(first.backupDir).not.toBeNull()
    expect(second.backupDir).not.toBeNull()
    expect(second.verification.ok).toBe(true)
    expect(await fs.readFile(path.join(target, "AGENTS.md"), "utf-8")).toBe(await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf-8"))
  })
})
