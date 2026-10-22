// This module owns the session state file and the history cap that keeps it bounded.

import fs from "node:fs/promises"
import {
  sessionPath,
  SessionState,
  SessionStateSchema,
  DEFAULT_SESSION,
} from "../schemas"
import { withLock } from "../locks"
import { writeWithBackup, findLatestValidBackup } from "../backups"
import { stripBom, writeFileChecksum, verifyFileChecksum } from "../checksums"
import { isENOENT } from "../errors"
import { pushCorruptionWarning } from "../warnings"
import { tryAutoCommit } from "./config"

export async function readSession(root: string): Promise<SessionState> {
  const fp = sessionPath(root)
  try {
    const checksumValid = await verifyFileChecksum(fp)
    if (!checksumValid) {
      pushCorruptionWarning(fp, "checksum mismatch, file may be corrupted")
    }

    const data = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(data))
    const merged = { ...DEFAULT_SESSION, ...parsed }
    const result = SessionStateSchema.safeParse(merged)
    if (result.success) {
      if (!checksumValid) await writeFileChecksum(fp)
      return result.data
    }
    pushCorruptionWarning(fp, result.error.message)
    const restored = await findLatestValidBackup<SessionState>(fp, root, SessionStateSchema)
    if (restored) {
      console.warn(`[SDD] Restored ${fp} from backup`)
      return restored
    }
    return { ...DEFAULT_SESSION }
  } catch (err) {
    if (!isENOENT(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      pushCorruptionWarning(fp, msg)
      const restored = await findLatestValidBackup<SessionState>(fp, root, SessionStateSchema)
      if (restored) {
        console.warn(`[SDD] Restored ${fp} from backup`)
        return restored
      }
    }
    return { ...DEFAULT_SESSION }
  }
}

export const MAX_SESSION_HISTORY = 20

export function prepareSessionForWrite(s: SessionState): SessionState {
  const history = Array.isArray(s.history) && s.history.length > MAX_SESSION_HISTORY
    ? s.history.slice(-MAX_SESSION_HISTORY)
    : s.history
  const next = { ...s, history }
  const result = SessionStateSchema.safeParse(next)
  if (!result.success) {
    throw new Error(`writeSession: validation failed, data not written: ${String(result.error)}`)
  }
  return result.data
}

export async function writeSession(root: string, s: SessionState): Promise<void> {
  const prepared = prepareSessionForWrite(s)
  s.history = prepared.history
  const fp = sessionPath(root)
  await withLock(fp, async () => {
    await writeWithBackup(fp, JSON.stringify(prepared, null, 2), root)
    await writeFileChecksum(fp)

    const written = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(written))
    const verify = SessionStateSchema.safeParse(parsed)
    if (!verify.success) {
      throw new Error(`writeSession: post-write verification failed: ${String(verify.error)}`)
    }

    const checksumValid = await verifyFileChecksum(fp)
    if (!checksumValid) {
      throw new Error(`writeSession: post-write checksum verification failed`)
    }
  })
  await tryAutoCommit(fp, root)
}
