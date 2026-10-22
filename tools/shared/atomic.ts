// This module owns the atomic replace that every state writer uses to keep a file from being truncated.

import path from "node:path"
import crypto from "node:crypto"
import fs from "node:fs/promises"

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"])
const RENAME_ATTEMPTS = 5

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return
  try {
    const handle = await fs.open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is best effort because some file systems refuse it.
  }
}

export async function atomicWriteFile(fp: string, data: string | Buffer): Promise<void> {
  const tmp = `${fp}.${process.pid}.${crypto.randomUUID()}.tmp`
  const dir = path.dirname(fp)
  await fs.mkdir(dir, { recursive: true })

  try {
    await fs.writeFile(tmp, data, { flag: "wx" })
    const handle = await fs.open(tmp, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }

  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmp, fp)
      await syncDirectory(dir)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ""
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt === RENAME_ATTEMPTS - 1) {
        await fs.rm(tmp, { force: true })
        throw new Error(`atomicWriteFile: rename failed for ${fp}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}
