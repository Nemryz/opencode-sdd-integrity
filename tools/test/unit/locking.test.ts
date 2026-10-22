import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  acquireLock,
  releaseLock,
  withLock,
  resetLocks,
  sleep,
  writeSession,
  readSession,
  writeSpecJson,
  readSpecJson,
  makeSpecJson,
  DEFAULT_SESSION,
} from "../../shared/types"

let tmp: string

async function worktree(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lock-test-"))
  return tmp
}

afterEach(async () => {
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── acquireLock ───────────────────────────────────────────

describe("acquireLock", () => {
  it("creates a lock directory", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle = await acquireLock(target)
    await expect(fs.stat(handle.lockDir)).resolves.toBeDefined()
    await releaseLock(handle)
  })

  it("returns a handle with lockDir and filePath", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle = await acquireLock(target)
    expect(handle.filePath).toBe(target)
    expect(handle.lockDir).toBe(target + ".lock")
    expect(handle.reentrant).toBe(false)
    await releaseLock(handle)
  })

  it("throws LockTimeout when lock held by another process", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const lockDir = target + ".lock"
    // manually create lock dir so heldLocks does not know about it
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 0, createdAt: new Date().toISOString() }),
      "utf-8",
    )
    await expect(acquireLock(target, { timeout: 100 })).rejects.toThrow("Lock timeout")
  })

  it("acquires lock after previous lock is released", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle1 = await acquireLock(target)
    await releaseLock(handle1)
    const handle2 = await acquireLock(target)
    await releaseLock(handle2)
  })

  it("steals a stale lock directory", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const lockDir = target + ".lock"
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 999999, createdAt: new Date(Date.now() - 60000).toISOString() }),
      "utf-8",
    )
    const handle = await acquireLock(target, { staleThreshold: 1000 })
    expect(handle.filePath).toBe(target)
    await releaseLock(handle)
  })

  it("steals lock immediately when owning PID is dead (T-9a)", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const lockDir = target + ".lock"
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }),
      "utf-8",
    )
    const start = Date.now()
    const handle = await acquireLock(target, { timeout: 5000, staleThreshold: 10000 })
    const elapsed = Date.now() - start
    expect(handle.filePath).toBe(target)
    expect(elapsed).toBeLessThan(100)
    await releaseLock(handle)
  })

  it("saves process.pid in lock.json (T-9b)", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle = await acquireLock(target)
    const raw = await fs.readFile(path.join(handle.lockDir, "lock.json"), "utf-8")
    const info = JSON.parse(raw)
    expect(info.pid).toBe(process.pid)
    await releaseLock(handle)
  })
})

// ── releaseLock ───────────────────────────────────────────

describe("releaseLock", () => {
  it("removes the lock directory", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle = await acquireLock(target)
    await releaseLock(handle)
    await expect(fs.stat(handle.lockDir)).rejects.toThrow()
  })

  it("is idempotent when called twice", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const handle = await acquireLock(target)
    await releaseLock(handle)
    await expect(releaseLock(handle)).resolves.toBeUndefined()
  })
})

// ── Reentrancy ────────────────────────────────────────────

describe("reentrant lock", () => {
  it("returns immediately when same file is already locked by this process", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const outer = await acquireLock(target)
    const inner = await acquireLock(target)
    expect(inner.reentrant).toBe(true)
    await releaseLock(inner)
    await releaseLock(outer)
  })

  it("keeps lock dir alive after reentrant release", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const outer = await acquireLock(target)
    const inner = await acquireLock(target)
    await releaseLock(inner)
    await expect(fs.stat(inner.lockDir)).resolves.toBeDefined()
    await releaseLock(outer)
  })

  it("writeSession inside withLock does not deadlock", async () => {
    const t = await worktree()
    const fp = path.join(t, ".opencode", "spec-memory", "session.json")
    const custom = { ...DEFAULT_SESSION, phase: "spec" as const }
    await withLock(fp, async () => {
      await writeSession(t, custom)
    })
    const result = await readSession(t)
    expect(result.phase).toBe("spec")
  })

  it("writeSpecJson inside withLock does not deadlock", async () => {
    const t = await worktree()
    const featureDir = path.join(t, "specs", "001-test")
    const sj = makeSpecJson("test", 1)
    const fp = path.join(featureDir, "spec.json")
    await withLock(fp, async () => {
      await writeSpecJson(sj, featureDir)
    })
    const result = await readSpecJson(featureDir)
    expect(result?.feature_name).toBe("test")
  })
})

// ── Stale detection edge cases ─────────────────────────

describe("stale lock detection edge cases", () => {
  it("steals a lock when lock.json has invalid date string (T-2)", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const lockDir = target + ".lock"
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 999999, createdAt: "not-a-date" }),
      "utf-8",
    )
    const handle = await acquireLock(target, { staleThreshold: 100, timeout: 500 })
    expect(handle.filePath).toBe(target)
    await releaseLock(handle)
  })

  it("steals a lock when lock dir exists but lock.json is missing (T-3)", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const lockDir = target + ".lock"
    await fs.mkdir(lockDir, { recursive: true })
    // no lock.json written — simulate crash between mkdir and writeFile
    const handle = await acquireLock(target, { staleThreshold: 100, timeout: 500 })
    expect(handle.filePath).toBe(target)
    await releaseLock(handle)
  })
})

// ── withLock ──────────────────────────────────────────────

describe("withLock", () => {
  it("acquires and releases lock around a callback", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    let ran = false
    await withLock(target, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    // lock dir should be gone
    await expect(fs.stat(target + ".lock")).rejects.toThrow()
  })

  it("releases lock when callback throws and propagates error (T-1)", async () => {
    const t = await worktree()
    const target = path.join(t, "test.json")
    const err = new Error("inside callback error")
    await expect(withLock(target, async () => { throw err })).rejects.toThrow("inside callback error")
    // lock dir must be cleaned up even after error
    await expect(fs.stat(target + ".lock")).rejects.toThrow()
  })

  it("protects read-modify-write from sequential overwrite", async () => {
    const t = await worktree()
    const fp = path.join(t, "data.json")
    await fs.writeFile(fp, JSON.stringify({ counter: 0 }), "utf-8")
    const ops = 5
    for (let i = 0; i < ops; i++) {
      await withLock(fp, async () => {
        const raw = await fs.readFile(fp, "utf-8")
        const data = JSON.parse(raw)
        data.counter++
        await fs.writeFile(fp, JSON.stringify(data), "utf-8")
      })
    }
    const final = JSON.parse(await fs.readFile(fp, "utf-8"))
    expect(final.counter).toBe(ops)
  })

  it("rejects non-blocking acquire when lock held by same process concurrently", async () => {
    const t = await worktree()
    const fp = path.join(t, "data.json")
    const lockDir = fp + ".lock"
    await fs.mkdir(path.dirname(lockDir), { recursive: true })
    await fs.mkdir(lockDir, { recursive: false })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf-8",
    )
    // the lock is held by the same process externally, so acquire uses stale detection
    // with a very fresh date it cannot steal, and timeout fires
    await expect(acquireLock(fp, { timeout: 50, staleThreshold: 10000 })).rejects.toThrow("Lock timeout")
  })
})

// ── sleep ─────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after at least the given milliseconds", async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

// ── resetLocks ─────────────────────────────────────────────

describe("resetLocks", () => {
  it("clears all held locks", async () => {
    const wt = await worktree()
    const fp = path.join(wt, "test.lock")
    const handle = await acquireLock(fp)
    expect(handle.reentrant).toBe(false)

    const reentry = await acquireLock(fp)
    expect(reentry.reentrant).toBe(true)
    await releaseLock(reentry)

    resetLocks()
    await releaseLock(handle)

    const afterReset = await acquireLock(fp, { timeout: 5000 })
    expect(afterReset.reentrant).toBe(false)
    await releaseLock(afterReset)
  })
})
