// This module owns the checksummed backup history that every state write leaves behind.

import path from "node:path"
import fs from "node:fs/promises"
import { computeSha256, stripBom, writeChecksumFile, verifyChecksum } from "./checksums"
import { atomicWriteFile } from "./atomic"

export const BACKUP_DIR_NAME = "backups"
const MAX_BACKUPS = 10

export function backupSourceKey(fp: string): string {
  const normalized = process.platform === "win32" ? path.resolve(fp).toLowerCase() : path.resolve(fp)
  return `${path.basename(fp)}.${computeSha256(normalized).slice(0, 8)}`
}

export function backupTimestamp(name: string): number {
  // Backup stamp format: YYYYMMDDTHHMMSSZ-hex (e.g., 20261020T215017Z-172f65)
  // Only match .bak files (not .sha256)
  if (!name.endsWith(".bak")) return 0
  const match = name.match(/\.(\d{8}T\d{6})Z/)
  if (match) {
    // Convert YYYYMMDDTHHMMSS to a sortable number: YYYYMMDDHHMMSS
    return Number(match[1].replace("T", ""))
  }
  // Fallback: try .digits.bak format
  const fallback = name.match(/\.(\d+)\.bak$/)
  return fallback ? Number(fallback[1]) : 0
}

export async function writeWithBackup(fp: string, data: string, root: string): Promise<void> {
  const existing = await fs.readFile(fp, "utf-8").catch(() => null)
  if (existing !== null) {
    const backupDir = path.join(root, ".opencode", BACKUP_DIR_NAME)
    const sourceKey = backupSourceKey(fp)
    await fs.mkdir(backupDir, { recursive: true })
    let timestamp = Date.now()
    let bakFile = path.join(backupDir, `${sourceKey}.${timestamp}.bak`)
    // Two writes in the same millisecond would share a backup name, so the stamp advances until the slot is free.
    while (await fs.access(bakFile).then(() => true).catch(() => false)) {
      timestamp += 1
      bakFile = path.join(backupDir, `${sourceKey}.${timestamp}.bak`)
    }

    await fs.writeFile(bakFile, existing, "utf-8")
    await writeChecksumFile(bakFile, existing)

    const verified = await verifyChecksum(bakFile, existing)
    if (!verified) {
      await fs.rm(bakFile, { force: true })
      await fs.rm(`${bakFile}.sha256`, { force: true })
      throw new Error(`Backup verification failed for ${fp}`)
    }

    const allBaks = await fs.readdir(backupDir).catch(() => [])
    const sourceBaks = allBaks
      .filter(f => f.startsWith(`${sourceKey}.`) && f.endsWith(".bak"))
      .sort((a, b) => backupTimestamp(b) - backupTimestamp(a))
    if (sourceBaks.length > MAX_BACKUPS) {
      for (const old of sourceBaks.slice(MAX_BACKUPS)) {
        await fs.rm(path.join(backupDir, old), { force: true })
        await fs.rm(path.join(backupDir, `${old}.sha256`), { force: true })
      }
    }
  }
  await atomicWriteFile(fp, data)
}

export async function findLatestValidBackup<T>(
  fp: string,
  root: string,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  const backupDir = path.join(root, ".opencode", BACKUP_DIR_NAME)
  const sourceKey = backupSourceKey(fp)

  let files: string[]
  try {
    files = await fs.readdir(backupDir)
  } catch {
    return null
  }

  const backups = files
    .filter(f => f.startsWith(`${sourceKey}.`) && f.endsWith(".bak"))
    .sort((a, b) => backupTimestamp(b) - backupTimestamp(a))

  for (const bak of backups) {
    try {
      const bakPath = path.join(backupDir, bak)
      const content = await fs.readFile(bakPath, "utf-8")
      const checksumValid = await verifyChecksum(bakPath, content)
      if (!checksumValid) continue
      const parsed = JSON.parse(stripBom(content))
      const result = schema.safeParse(parsed)
      if (result.success) {
        return result.data as T
      }
    } catch {
      continue
    }
  }
  return null
}

export interface BackupIntegrityReport {
  totalBackups: number
  valid: number
  corrupted: number
  missingChecksum: number
  details: Array<{
    file: string
    status: "valid" | "corrupted" | "missing-checksum" | "read-error"
    error?: string
  }>
}

export async function verifyBackupIntegrity(
  root: string,
  schemas: Record<string, { safeParse: (data: unknown) => { success: boolean } }>,
): Promise<BackupIntegrityReport> {
  const backupDir = path.join(root, ".opencode", BACKUP_DIR_NAME)
  const report: BackupIntegrityReport = {
    totalBackups: 0,
    valid: 0,
    corrupted: 0,
    missingChecksum: 0,
    details: [],
  }

  let files: string[]
  try {
    files = await fs.readdir(backupDir)
  } catch {
    return report
  }

  const bakFiles = files.filter(f => f.endsWith(".bak"))
  report.totalBackups = bakFiles.length

  for (const bak of bakFiles) {
    const bakPath = path.join(backupDir, bak)
    try {
      const content = await fs.readFile(bakPath, "utf-8")

      const checksumValid = await verifyChecksum(bakPath, content)
      if (!checksumValid) {
        report.missingChecksum++
        report.details.push({ file: bak, status: "missing-checksum" })
        continue
      }

      const basename = bak.replace(/\.\w{8}\.\d+\.bak$/, "").replace(/\.\d+\.bak$/, "")
      const schema = schemas[basename]
      if (schema) {
        const parsed = JSON.parse(stripBom(content))
        if (schema.safeParse(parsed).success) {
          report.valid++
          report.details.push({ file: bak, status: "valid" })
        } else {
          report.corrupted++
          report.details.push({ file: bak, status: "corrupted" })
        }
      } else {
        report.valid++
        report.details.push({ file: bak, status: "valid" })
      }
    } catch (err) {
      report.corrupted++
      report.details.push({
        file: bak,
        status: "read-error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return report
}
