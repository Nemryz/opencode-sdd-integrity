// This module owns the lock directory protocol that serializes writers across processes.

import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { isEEXIST, isESRCH } from "./errors"
import { stripBom } from "./checksums"

export interface LockOptions {
  timeout?: number
  staleThreshold?: number
}

export interface LockHandle {
  lockDir: string
  filePath: string
  reentrant?: boolean
  token?: string
}

interface LockInfo {
  pid: number
  createdAt: string
  token?: string
}

const heldLocks = new Set<string>()
const lockContext = new AsyncLocalStorage<Set<string>>()

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readLockJson(lockDir: string): Promise<LockInfo | null> {
  try {
    const data = await fs.readFile(path.join(lockDir, "lock.json"), "utf-8")
    return JSON.parse(stripBom(data))
  } catch {
    return null
  }
}

async function removeLockDir(lockDir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(lockDir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(10)
    }
  }
  return false
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (isESRCH(err)) {
      return false
    }
    return true
  }
}

export async function acquireLock(
  filePath: string,
  options?: LockOptions,
  internal?: { ignoreProcessHeld?: boolean },
): Promise<LockHandle> {
  const lockDir = filePath + ".lock"
  const contextHeld = lockContext.getStore()
  if (contextHeld?.has(lockDir)) {
    return { lockDir, filePath, reentrant: true }
  }
  if (!internal?.ignoreProcessHeld && heldLocks.has(lockDir)) {
    return { lockDir, filePath, reentrant: true }
  }
  const timeout = options?.timeout ?? 5000
  const staleThreshold = options?.staleThreshold ?? 10000
  const start = Date.now()
  const token = `${process.pid}:${crypto.randomUUID()}`

  while (true) {
    try {
      const parentDir = path.dirname(lockDir)
      try {
        await fs.access(parentDir)
      } catch {
        await fs.mkdir(parentDir, { recursive: true })
      }
      await fs.mkdir(lockDir, { recursive: false })
      await fs.writeFile(
        path.join(lockDir, "lock.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token }),
        "utf-8",
      )
      heldLocks.add(lockDir)
      return { lockDir, filePath, reentrant: false, token }
    } catch (err) {
      if (isEEXIST(err)) {
        const info = await readLockJson(lockDir)
        if (info && info.pid !== process.pid && !isPidAlive(info.pid)) {
          if (await removeLockDir(lockDir)) continue
        }

        let stale = false
        const createdAt = info ? new Date(info.createdAt).getTime() : NaN
        if (!info || isNaN(createdAt)) {
          // A creator may sit between mkdir and writeFile, so a young directory is not stolen.
          const stat = await fs.stat(lockDir).catch(() => null)
          stale = stat ? Date.now() - stat.mtimeMs > staleThreshold : false
        } else {
          stale = Date.now() - createdAt > staleThreshold
        }

        if (stale) {
          if (await removeLockDir(lockDir)) continue
        }
        if (Date.now() - start >= timeout) {
          throw new Error(`Lock timeout: could not acquire lock for ${filePath}`)
        }
        await sleep(50)
        continue
      }
      throw err
    }
  }
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  if (handle.reentrant) return
  try {
    const info = await readLockJson(handle.lockDir)
    if (info?.token && info.token !== handle.token) {
      return
    }
    heldLocks.delete(handle.lockDir)
    await removeLockDir(handle.lockDir)
  } catch {
    heldLocks.delete(handle.lockDir)
  }
}

export function resetLocks(): void {
  heldLocks.clear()
}

export async function withLock<T>(filePath: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  const lockDir = filePath + ".lock"
  const contextHeld = lockContext.getStore()
  if (contextHeld?.has(lockDir)) {
    return fn()
  }
  const handle = await acquireLock(filePath, options, { ignoreProcessHeld: true })
  const nextHeld = new Set(contextHeld ?? [])
  nextHeld.add(lockDir)
  try {
    return await lockContext.run(nextHeld, fn)
  } finally {
    await releaseLock(handle)
  }
}
