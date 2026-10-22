import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  exists,
  readSession,
  writeSession,
  readSpecJson,
  writeSpecJson,
  writeWithBackup,
  backupSourceKey,
  atomicWriteFile,
  getFeatureDirs,
  getLatestFeatureDir,
  makeSpecJson,
  DEFAULT_SESSION,
  DEFAULT_CONFIG,
  sessionPath,
  specJsonPath,
  specsDirPath,
  configPath,
  readConfig,
  tryAutoCommit,
} from "../../shared/types"

let tmp: string

async function worktree(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shared-io-"))
  return tmp
}

afterEach(async () => {
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── exists ─────────────────────────────────────────────────

describe("exists", () => {
  it("returns false for a missing file", async () => {
    const root = await worktree()
    expect(await exists(path.join(root, "nope"))).toBe(false)
  })

  it("returns true for an existing file", async () => {
    const root = await worktree()
    const fp = path.join(root, "present.txt")
    await fs.writeFile(fp, "hello", "utf-8")
    expect(await exists(fp)).toBe(true)
  })

  it("returns true for an existing directory", async () => {
    const root = await worktree()
    expect(await exists(root)).toBe(true)
  })
})

// ── readSession ────────────────────────────────────────────

describe("readSession", () => {
  it("returns DEFAULT_SESSION when the file does not exist", async () => {
    const root = await worktree()
    const result = await readSession(root)
    expect(result).toEqual(DEFAULT_SESSION)
  })

  it("merges stored values with DEFAULT_SESSION on valid JSON", async () => {
    const root = await worktree()
    const fp = sessionPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ phase: "spec", featureName: "test" }), "utf-8")
    const result = await readSession(root)
    expect(result.phase).toBe("spec")
    expect(result.featureName).toBe("test")
    expect(result.command).toBeNull()
    expect(result.history).toEqual([])
  })

  it("returns DEFAULT_SESSION on invalid JSON", async () => {
    const root = await worktree()
    const fp = sessionPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "not json", "utf-8")
    const result = await readSession(root)
    expect(result).toEqual(DEFAULT_SESSION)
  })

  it("returns DEFAULT_SESSION when session.json has wrong types", async () => {
    const root = await worktree()
    const fp = sessionPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ history: "not-an-array", phase: 12345 }), "utf-8")
    const result = await readSession(root)
    expect(result).toEqual(DEFAULT_SESSION)
  })
})

// ── writeSession + readSession roundtrip ───────────────────

describe("writeSession + readSession", () => {
  it("writes and reads back session data", async () => {
    const root = await worktree()
    const s = {
      ...DEFAULT_SESSION,
      phase: "plan" as const,
      featureName: "my feature",
    }
    await writeSession(root, s)
    const result = await readSession(root)
    expect(result.phase).toBe("plan")
    expect(result.featureName).toBe("my feature")
  })

  it("throws on invalid session data and preserves existing file", async () => {
    const root = await worktree()
    const valid = { ...DEFAULT_SESSION, phase: "spec" as const, featureName: "original" }
    await writeSession(root, valid)
    await expect(writeSession(root, { phase: "bogus" } as any)).rejects.toThrow("writeSession: validation failed")
    const result = await readSession(root)
    expect(result.phase).toBe("spec")
    expect(result.featureName).toBe("original")
  })
})

// ── readSpecJson ───────────────────────────────────────────

describe("readSpecJson", () => {
  it("returns null when the file does not exist", async () => {
    const root = await worktree()
    expect(await readSpecJson(path.join(root, "specs", "001-foo"))).toBeNull()
  })

  it("returns parsed SpecJson for valid content", async () => {
    const root = await worktree()
    const featureDir = path.join(root, "specs", "001-test")
    const sj = makeSpecJson("test", 1)
    await writeSpecJson(sj, featureDir)
    const result = await readSpecJson(featureDir)
    expect(result).not.toBeNull()
    expect(result!.feature_name).toBe("test")
    expect(result!.feature_number).toBe(1)
    expect(result!.phase).toBe("spec")
  })

  it("returns null for invalid JSON", async () => {
    const root = await worktree()
    const featureDir = path.join(root, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "spec.json"), "not json", "utf-8")
    const result = await readSpecJson(featureDir)
    expect(result).toBeNull()
  })

  it("returns null for valid JSON but invalid schema", async () => {
    const root = await worktree()
    const featureDir = path.join(root, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "spec.json"), JSON.stringify({ bad: true }), "utf-8")
    const result = await readSpecJson(featureDir)
    expect(result).toBeNull()
  })
})

// ── writeSpecJson + readSpecJson roundtrip ─────────────────

describe("writeSpecJson + readSpecJson", () => {
  it("writes and reads back spec data, updates updated_at", async () => {
    const root = await worktree()
    const featureDir = path.join(root, "specs", "001-test")
    const sj = makeSpecJson("roundtrip", 2)
    const originalUpdated = sj.updated_at
    await sleep(10)
    await writeSpecJson(sj, featureDir)
    expect(sj.updated_at).not.toBe(originalUpdated)
    const result = await readSpecJson(featureDir)
    expect(result).not.toBeNull()
    expect(result!.feature_name).toBe("roundtrip")
    expect(result!.feature_number).toBe(2)
  })

  it("throws on invalid spec data and preserves existing file", async () => {
    const root = await worktree()
    const featureDir = path.join(root, "specs", "001-test")
    const valid = makeSpecJson("original", 1)
    await writeSpecJson(valid, featureDir)
    await expect(writeSpecJson({ bad: true } as any, featureDir)).rejects.toThrow("writeSpecJson: validation failed")
    const result = await readSpecJson(featureDir)
    expect(result).not.toBeNull()
    expect(result!.feature_name).toBe("original")
  })
})

// ── atomicWriteFile ─────────────────────────────────────

describe("atomicWriteFile", () => {
  it("writes file and cleans up tmp", async () => {
    const root = await worktree()
    const fp = path.join(root, "test.json")
    await atomicWriteFile(fp, JSON.stringify({ a: 1 }))
    const content = await fs.readFile(fp, "utf-8")
    expect(JSON.parse(content)).toEqual({ a: 1 })
    expect(await exists(fp + ".tmp")).toBe(false)
  })

  it("overwrites existing file atomically", async () => {
    const root = await worktree()
    const fp = path.join(root, "test.json")
    await atomicWriteFile(fp, JSON.stringify({ v: "old" }))
    await atomicWriteFile(fp, JSON.stringify({ v: "new" }))
    const content = JSON.parse(await fs.readFile(fp, "utf-8"))
    expect(content.v).toBe("new")
  })

  it("creates parent directories", async () => {
    const root = await worktree()
    const fp = path.join(root, "deep", "nested", "file.json")
    await atomicWriteFile(fp, JSON.stringify({ ok: true }))
    expect(JSON.parse(await fs.readFile(fp, "utf-8"))).toEqual({ ok: true })
  })

  it("handles empty content", async () => {
    const root = await worktree()
    const fp = path.join(root, "empty.json")
    await atomicWriteFile(fp, "")
    expect(await fs.readFile(fp, "utf-8")).toBe("")
  })
})

// ── getFeatureDirs ─────────────────────────────────────────

describe("getFeatureDirs", () => {
  it("returns empty array when specs dir is missing", async () => {
    const root = await worktree()
    const dirs = await getFeatureDirs(root)
    expect(dirs).toEqual([])
  })

  it("returns NNN-prefixed dirs sorted by number", async () => {
    const root = await worktree()
    const sd = specsDirPath(root)
    await fs.mkdir(path.join(sd, "003-z"), { recursive: true })
    await fs.mkdir(path.join(sd, "001-a"), { recursive: true })
    await fs.mkdir(path.join(sd, "002-b"), { recursive: true })
    const dirs = await getFeatureDirs(root)
    expect(dirs).toEqual(["001-a", "002-b", "003-z"])
  })

  it("ignores non-NNN directories", async () => {
    const root = await worktree()
    const sd = specsDirPath(root)
    await fs.mkdir(path.join(sd, "001-real"), { recursive: true })
    await fs.mkdir(path.join(sd, "ignored"), { recursive: true })
    await fs.mkdir(path.join(sd, "also-ignored"), { recursive: true })
    const dirs = await getFeatureDirs(root)
    expect(dirs).toEqual(["001-real"])
  })
})

// ── getLatestFeatureDir ────────────────────────────────────

describe("getLatestFeatureDir", () => {
  it("returns null when no feature dirs exist", async () => {
    const root = await worktree()
    expect(await getLatestFeatureDir(root)).toBeNull()
  })

  it("returns the highest-numbered feature dir", async () => {
    const root = await worktree()
    const sd = specsDirPath(root)
    await fs.mkdir(path.join(sd, "001-a"), { recursive: true })
    await fs.mkdir(path.join(sd, "002-b"), { recursive: true })
    await fs.mkdir(path.join(sd, "003-c"), { recursive: true })
    expect(await getLatestFeatureDir(root)).toBe("003-c")
  })
})

// ── writeWithBackup ─────────────────────────────────────────────────

describe("writeWithBackup", () => {
  it("creates backup before writing", async () => {
    const root = await worktree()
    const fp = path.join(root, ".opencode", "spec-memory", "session.json")
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "before", "utf-8")
    await writeWithBackup(fp, "after", root)
    const content = await fs.readFile(fp, "utf-8")
    expect(content).toBe("after")
    const backupDir = path.join(root, ".opencode", "backups")
    const baks = await fs.readdir(backupDir)
    const bakFiles = baks.filter(f => f.endsWith(".bak"))
    const shaFiles = baks.filter(f => f.endsWith(".sha256"))
    expect(bakFiles.length).toBe(1)
    expect(shaFiles.length).toBe(1)
    const bakContent = await fs.readFile(path.join(backupDir, bakFiles[0]), "utf-8")
    expect(bakContent).toBe("before")
  })

  it("does not create backup on first write", async () => {
    const root = await worktree()
    const fp = path.join(root, ".opencode", "spec-memory", "session.json")
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "first", "utf-8")
    await fs.rm(fp)
    await writeWithBackup(fp, "first", root)
    const backupDir = path.join(root, ".opencode", "backups")
    const baks = await fs.readdir(backupDir).catch(() => [] as string[])
    expect(baks.length).toBe(0)
  })

  it("trims old backups to MAX_BACKUPS", async () => {
    const root = await worktree()
    const fp = path.join(root, ".opencode", "spec-memory", "session.json")
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "base", "utf-8")
    const backupDir = path.join(root, ".opencode", "backups")
    await fs.mkdir(backupDir, { recursive: true })
    const sourceKey = backupSourceKey(fp)
    for (let i = 0; i < 15; i++) {
      await fs.writeFile(path.join(backupDir, `${sourceKey}.${1000 + i}.bak`), `old-${i}`, "utf-8")
    }
    await writeWithBackup(fp, "new", root)
    const baks = await fs.readdir(backupDir)
    const bakFiles = baks.filter(f => f.startsWith(`${sourceKey}.`) && f.endsWith(".bak"))
    expect(bakFiles.length).toBe(10)
  })

  it("backup survives atomicWriteFile failure", async () => {
    const root = await worktree()
    const fp = path.join(root, ".opencode", "spec-memory", "session.json")
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "original", "utf-8")
    await writeWithBackup(fp, "updated", root)
    const backupDir = path.join(root, ".opencode", "backups")
    const baks = await fs.readdir(backupDir)
    const bakFiles = baks.filter(f => f.endsWith(".bak"))
    expect(bakFiles.length).toBe(1)
    const bakContent = await fs.readFile(path.join(backupDir, baks[0]), "utf-8")
    expect(bakContent).toBe("original")
  })
})

// ── readConfig ──────────────────────────────────────────────────────

describe("readConfig", () => {
  it("returns DEFAULT_CONFIG when the file does not exist", async () => {
    const root = await worktree()
    const result = await readConfig(root)
    expect(result).toEqual(DEFAULT_CONFIG)
  })

  it("returns DEFAULT_CONFIG on invalid JSON", async () => {
    const root = await worktree()
    const fp = configPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, "not json", "utf-8")
    const result = await readConfig(root)
    expect(result).toEqual(DEFAULT_CONFIG)
  })

  it("merges stored values with DEFAULT_CONFIG", async () => {
    const root = await worktree()
    const fp = configPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ autoVersioning: true }), "utf-8")
    const result = await readConfig(root)
    expect(result.autoVersioning).toBe(true)
    expect(result.expressMode).toBe(false)
    expect(result.defaultTechStack).toBeNull()
  })
})

// ── tryAutoCommit ───────────────────────────────────────────────────

describe("tryAutoCommit", () => {
  it("is a no-op when root is not a git repo", async () => {
    const root = await worktree()
    const fp = path.join(root, "test.txt")
    await fs.writeFile(fp, "hello", "utf-8")
    await expect(tryAutoCommit(fp, root)).resolves.toBeUndefined()
  })

  it("is a no-op when autoVersioning is false", async () => {
    const root = await worktree()
    const fp = path.join(root, "test.txt")
    await fs.writeFile(fp, "hello", "utf-8")
    await expect(tryAutoCommit(fp, root)).resolves.toBeUndefined()
  })

  it("auto-commits when autoVersioning is true and git repo exists", async () => {
    const root = await worktree()
    const fp = configPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ autoVersioning: true }), "utf-8")
    const { execSync } = await import("node:child_process")
    execSync("git init", { cwd: root, stdio: "ignore" })
    execSync('git config user.email "test@test.com"', { cwd: root, stdio: "ignore" })
    execSync('git config user.name "Test"', { cwd: root, stdio: "ignore" })
    const testFile = path.join(root, "hello.txt")
    await fs.writeFile(testFile, "world", "utf-8")
    execSync("git add -A", { cwd: root, stdio: "ignore" })
    execSync("git commit -m initial", { cwd: root, stdio: "ignore" })
    await fs.writeFile(testFile, "updated", "utf-8")
    await tryAutoCommit(testFile, root)
    const log = execSync("git log --oneline", { cwd: root, encoding: "utf-8" })
    expect(log).toContain("auto: update hello.txt")
  })

  it("fails silently on git errors", async () => {
    const root = await worktree()
    const fp = configPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ autoVersioning: true }), "utf-8")
    const { execSync } = await import("node:child_process")
    execSync("git init", { cwd: root, stdio: "ignore" })
    execSync('git config user.email "test@test.com"', { cwd: root, stdio: "ignore" })
    execSync('git config user.name "Test"', { cwd: root, stdio: "ignore" })
    const testFile = path.join(root, "missing.txt")
    await expect(tryAutoCommit(testFile, root)).resolves.toBeUndefined()
  })
})

// ── writeSession auto-commit integration ────────────────────────────

describe("writeSession with autoVersioning", () => {
  it("auto-commits session.json when autoVersioning is enabled", async () => {
    const root = await worktree()
    const fp = configPath(root)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, JSON.stringify({ autoVersioning: true }), "utf-8")
    const { execSync } = await import("node:child_process")
    execSync("git init", { cwd: root, stdio: "ignore" })
    execSync('git config user.email "test@test.com"', { cwd: root, stdio: "ignore" })
    execSync('git config user.name "Test"', { cwd: root, stdio: "ignore" })
    const s = { ...DEFAULT_SESSION, phase: "spec" as const }
    await writeSession(root, s)
    const log = execSync("git log --oneline", { cwd: root, encoding: "utf-8" })
    expect(log).toContain("auto: update session state")
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
