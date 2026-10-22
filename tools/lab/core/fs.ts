import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  try {
    await fs.rename(temporary, file)
  } catch {
    await fs.rm(file, { force: true })
    await fs.rename(temporary, file)
  }
}

export async function writeTextAtomic(file: string, value: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, value, "utf-8")
  try {
    await fs.rename(temporary, file)
  } catch {
    await fs.rm(file, { force: true })
    await fs.rename(temporary, file)
  }
}

export interface LabLockOptions {
  timeoutMs?: number
  staleMs?: number
  pollMs?: number
}

// A directory is atomic across processes. The lock is intentionally short lived; stale locks are
// removed only after the owner had ample time to finish a registry read/write cycle.
export async function withLabLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: LabLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const pollMs = options.pollMs ?? 25
  const started = Date.now()
  await ensureDir(path.dirname(lockPath))

  while (true) {
    try {
      await fs.mkdir(lockPath, { recursive: false })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const stat = await fs.stat(lockPath)
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for the lab registry lock at ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  try {
    return await action()
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => null)
  }
}

// Creates a sortable id without depending on a locale or a clock format.
export function makeLabId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  return `${stamp}-${randomUUID().slice(0, 8)}`
}
