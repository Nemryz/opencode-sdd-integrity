// This module owns the feature state file that records phase, approvals and archive metadata.

import path from "node:path"
import fs from "node:fs/promises"
import { specJsonPath, SpecJson, SpecJsonSchema } from "../schemas"
import { withLock } from "../locks"
import { writeWithBackup, findLatestValidBackup } from "../backups"
import { stripBom, writeFileChecksum, verifyFileChecksum } from "../checksums"
import { isENOENT } from "../errors"
import { pushCorruptionWarning } from "../warnings"
import { tryAutoCommit } from "./config"

export async function readSpecJson(featureDir: string): Promise<SpecJson | null> {
  const fp = specJsonPath(featureDir)
  const root = path.dirname(path.dirname(featureDir))
  try {
    const checksumValid = await verifyFileChecksum(fp)
    if (!checksumValid) {
      pushCorruptionWarning(fp, "checksum mismatch, file may be corrupted")
    }

    const data = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(data))
    const result = SpecJsonSchema.safeParse(parsed)
    if (result.success) {
      if (!checksumValid) await writeFileChecksum(fp)
      return result.data
    }
    pushCorruptionWarning(fp, result.error.message)
    const restored = await findLatestValidBackup<SpecJson>(fp, root, SpecJsonSchema)
    if (restored) {
      console.warn(`[SDD] Restored ${fp} from backup`)
      return restored
    }
    return null
  } catch (err) {
    if (!isENOENT(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      pushCorruptionWarning(fp, msg)
      const restored = await findLatestValidBackup<SpecJson>(fp, root, SpecJsonSchema)
      if (restored) {
        console.warn(`[SDD] Restored ${fp} from backup`)
        return restored
      }
    }
    return null
  }
}

export async function writeSpecJson(sj: SpecJson, featureDir: string): Promise<void> {
  sj.updated_at = new Date().toISOString()
  const result = SpecJsonSchema.safeParse(sj)
  if (!result.success) {
    throw new Error(`writeSpecJson: validation failed, data not written: ${String(result.error)}`)
  }
  const root = path.dirname(path.dirname(featureDir))
  const fp = specJsonPath(featureDir)
  await withLock(fp, async () => {
    await writeWithBackup(fp, JSON.stringify(result.data, null, 2), root)
    await writeFileChecksum(fp)

    const written = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(written))
    const verify = SpecJsonSchema.safeParse(parsed)
    if (!verify.success) {
      throw new Error(`writeSpecJson: post-write verification failed: ${String(verify.error)}`)
    }

    const checksumValid = await verifyFileChecksum(fp)
    if (!checksumValid) {
      throw new Error(`writeSpecJson: post-write checksum verification failed`)
    }
  })
  await tryAutoCommit(fp, root)
}
