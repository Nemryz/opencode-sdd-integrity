import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  acquireLock,
  releaseLock,
  resetLocks,
  withLock,
  sleep,
  sessionPath,
  writeSession,
  readSession,
  DEFAULT_SESSION,
  withStateLock,
} from "../../shared/types"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"

let tmp: string

beforeEach(async () => {
  resetLocks()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lock-safety-"))
})

afterEach(async () => {
  resetLocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("withLock parallel exclusion", () => {
  it("serializes parallel withLock calls on the same file", async () => {
    const fp = path.join(tmp, "parallel.json")
    let active = 0
    let maxActive = 0

    const worker = () => withLock(fp, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(40)
      active--
    }, { staleThreshold: 60000, timeout: 10000 })

    await Promise.all([worker(), worker(), worker()])
    expect(maxActive).toBe(1)
  })

  it("serializes parallel withLock calls on the same file with different work durations", async () => {
    const fp = path.join(tmp, "parallel2.json")
    const order: number[] = []

    const worker = (id: number, ms: number) => withLock(fp, async () => {
      order.push(id)
      await sleep(ms)
    }, { staleThreshold: 60000, timeout: 10000 })

    await Promise.all([worker(1, 60), worker(2, 10), worker(3, 10)])
    expect(order.length).toBe(3)
    expect(new Set(order).size).toBe(3)
  })

  it("supports nested withLock on the same file without deadlock", async () => {
    const fp = path.join(tmp, "nested.json")
    const result = await withLock(fp, async () => {
      return await withLock(fp, async () => "inner-done")
    })
    expect(result).toBe("inner-done")
  })

  it("allows writeSession inside withLock on the same file", async () => {
    const root = await createTempWorktree()
    try {
      await withStateLock(root, () => withLock(sessionPath(root), async () => {
        await writeSession(root, {
          ...DEFAULT_SESSION,
          phase: "plan",
          featureDir: "001-test",
          featureNumber: 1,
          featureName: "test",
        })
      }))
      const session = await readSession(root)
      expect(session.phase).toBe("plan")
    } finally {
      await destroyTempWorktree(root)
    }
  })
})

describe("withLock ownership tokens", () => {
  it("releaseLock with matching token removes the lock", async () => {
    const fp = path.join(tmp, "token-ok.json")
    const handle = await acquireLock(fp)
    expect(handle.token).toBeTruthy()
    await releaseLock(handle)
    const exists = await fs.access(fp + ".lock").then(() => true, () => false)
    expect(exists).toBe(false)
  })

  it("releaseLock with mismatched token leaves the lock in place", async () => {
    const fp = path.join(tmp, "token-mismatch.json")
    const handle = await acquireLock(fp)
    await fs.writeFile(
      path.join(fp + ".lock", "lock.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "foreign-token" }),
      "utf-8",
    )
    await releaseLock(handle)
    const exists = await fs.access(fp + ".lock").then(() => true, () => false)
    expect(exists).toBe(true)
  })

  it("records pid and token in lock.json", async () => {
    const fp = path.join(tmp, "lockinfo.json")
    const handle = await acquireLock(fp)
    try {
      const info = JSON.parse(await fs.readFile(path.join(fp + ".lock", "lock.json"), "utf-8"))
      expect(info.pid).toBe(process.pid)
      expect(info.token).toBe(handle.token)
    } finally {
      await releaseLock(handle)
    }
  })
})
