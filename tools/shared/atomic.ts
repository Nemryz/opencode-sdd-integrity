// This module owns the atomic replace that every state writer uses to keep a file from being truncated.

import path from "node:path"
import fs from "node:fs/promises"

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"])
const RENAME_ATTEMPTS = 5

export async function atomicWriteFile(fp: string, data: string | Buffer): Promise<void> {
  const tmp = fp + ".tmp"
  const dir = path.dirname(fp)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(tmp, data, "utf-8")
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmp, fp)
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
