import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  configPath,
  DEFAULT_CONFIG,
  tryAutoCommit,
  writeFileChecksum,
  type SDDConfig,
} from "../../shared/types"

let root: string

function makeConfig(overrides: Partial<SDDConfig> = {}): SDDConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

function gitInit(): void {
  execSync("git init", { cwd: root, stdio: "ignore" })
  execSync('git config user.email "test@test.com"', { cwd: root, stdio: "ignore" })
  execSync('git config user.name "Test"', { cwd: root, stdio: "ignore" })
}

function gitCommitAll(message: string): void {
  execSync("git add -A", { cwd: root, stdio: "ignore" })
  execSync(`git commit -m "${message}"`, { cwd: root, stdio: "ignore" })
}

function gitLogCount(): number {
  return execSync("git log --oneline", { cwd: root, encoding: "utf-8" }).trim().split("\n").filter(Boolean).length
}

async function writeConfig(config: SDDConfig): Promise<void> {
  const fp = configPath(root)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.writeFile(fp, JSON.stringify(config, null, 2), "utf-8")
  await writeFileChecksum(fp)
}

beforeEach(async () => {
  root = await createTempWorktree()
})

afterEach(async () => {
  await destroyTempWorktree(root)
})

describe("auto versioning language-only changes", () => {
  it("reverts a change that only touches lastUsedLanguage", async () => {
    gitInit()
    await writeConfig(makeConfig({ autoVersioning: true }))
    gitCommitAll("initial")
    const before = gitLogCount()

    await writeConfig(makeConfig({ autoVersioning: true, lastUsedLanguage: "es" }))
    await tryAutoCommit(configPath(root), root)

    expect(gitLogCount()).toBe(before)
    const restored = JSON.parse(await fs.readFile(configPath(root), "utf-8"))
    expect(restored.lastUsedLanguage).toBeNull()
  })

  it("commits a config change that is not language-only", async () => {
    gitInit()
    await writeConfig(makeConfig({ autoVersioning: true }))
    gitCommitAll("initial")
    const before = gitLogCount()

    await writeConfig(makeConfig({ autoVersioning: true, expressMode: true }))
    await tryAutoCommit(configPath(root), root)

    expect(gitLogCount()).toBe(before + 1)
    expect(execSync("git log -1 --pretty=%B", { cwd: root, encoding: "utf-8" }).trim())
      .toBe("auto: update config")
  })
})
