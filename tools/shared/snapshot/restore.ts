import fs from "node:fs/promises"
import path from "node:path"
import { atomicWriteFile } from "../io"
import type { RestoreJournal, SnapshotManifest } from "../schemas"
import { createSnapshot, readSnapshotManifest, verifySnapshot } from "./manifest"
import {
  assertSafeManifestPath,
  clearRestoreJournal,
  collectScope,
  readRestoreJournal,
  sha256,
  snapshotsDirPath,
  writeRestoreJournal,
} from "./paths"

// This module owns everything that writes state back, meaning preview, restore and interrupted restore recovery.

// Writes the captured files and drops the ones that appeared after the snapshot was taken.
async function applyManifest(
  root: string,
  snapshotId: string,
  manifest: SnapshotManifest,
  paths: string[] | null,
  removeExtras: boolean,
): Promise<{ restored: string[]; removed: string[] }> {
  const snapshotDir = path.join(snapshotsDirPath(root), snapshotId)
  const targets = paths === null ? manifest.files : manifest.files.filter((file) => paths.includes(file.path))
  const restored: string[] = []
  for (const file of targets) {
    assertSafeManifestPath(file.path)
    const content = await fs.readFile(path.join(snapshotDir, ...file.path.split("/")))
    if (sha256(content) !== file.sha256) {
      throw new Error(`snapshot file checksum mismatch: ${file.path}`)
    }
    await atomicWriteFile(path.join(root, ...file.path.split("/")), content)
    restored.push(file.path)
  }
  const removed: string[] = []
  if (removeExtras) {
    const manifestPaths = new Set(manifest.files.map((file) => file.path))
    const current = await collectScope(root)
    for (const rel of current) {
      if (!manifestPaths.has(rel)) {
        await fs.rm(path.join(root, ...rel.split("/")), { force: true })
        removed.push(rel)
      }
    }
  }
  return { restored, removed }
}

export interface RestorePreview {
  id: string
  mode: "full" | "selective"
  entries: Array<{ path: string; status: "identical" | "changed" | "missing" }>
  extras: string[]
  errors: string[]
}

// Describes what a restore would do without writing a single file.
export async function previewRestore(
  root: string,
  id: string,
  options?: { mode?: "full" | "selective"; files?: string[] },
): Promise<RestorePreview> {
  const mode = options?.mode ?? "full"
  const manifest = await readSnapshotManifest(root, id)
  if (!manifest) {
    throw new Error(`snapshot ${id} is unreadable`)
  }
  const errors: string[] = []
  let targets = manifest.files
  if (mode === "selective") {
    const requested = options?.files ?? []
    const manifestPaths = new Set(manifest.files.map((file) => file.path))
    const safe: string[] = []
    for (const rel of requested) {
      try {
        assertSafeManifestPath(rel)
      } catch {
        errors.push(`unsafe snapshot path: ${rel}`)
        continue
      }
      if (!manifestPaths.has(rel)) {
        errors.push(`path not in snapshot manifest: ${rel}`)
        continue
      }
      safe.push(rel)
    }
    targets = manifest.files.filter((file) => safe.includes(file.path))
  }
  const entries: RestorePreview["entries"] = []
  for (const file of targets) {
    try {
      const content = await fs.readFile(path.join(root, ...file.path.split("/")))
      entries.push({ path: file.path, status: sha256(content) === file.sha256 ? "identical" : "changed" })
    } catch {
      entries.push({ path: file.path, status: "missing" })
    }
  }
  let extras: string[] = []
  if (mode === "full") {
    const manifestPaths = new Set(manifest.files.map((file) => file.path))
    extras = (await collectScope(root)).filter((rel) => !manifestPaths.has(rel))
  }
  return { id, mode, entries, extras, errors }
}

export interface RestoreOptions {
  confirmed: boolean
  mode?: "full" | "selective"
  files?: string[]
  now?: Date
}

export interface RestoreReport {
  id: string
  mode: "full" | "selective"
  restored: string[]
  removed: string[]
  safetySnapshotId: string
}

// Restores behind a safety snapshot and a journal so any failure can be rolled back or recovered later.
export async function restoreSnapshot(root: string, id: string, options: RestoreOptions): Promise<RestoreReport> {
  const mode = options.mode ?? "full"
  if (!options.confirmed) {
    throw new Error("restore requires confirmed: true after explicit user confirmation")
  }
  const manifest = await readSnapshotManifest(root, id)
  if (!manifest) {
    throw new Error(`snapshot ${id} is unreadable`)
  }
  const verification = await verifySnapshot(root, id)
  if (!verification.ok) {
    throw new Error(`snapshot ${id} failed verification`)
  }

  const manifestPaths = new Set(manifest.files.map((file) => file.path))
  let paths: string[] | null = null
  if (mode === "selective") {
    const requested = options.files ?? []
    if (requested.length === 0) {
      throw new Error("selective restore requires at least one file")
    }
    for (const rel of requested) {
      assertSafeManifestPath(rel)
      if (!manifestPaths.has(rel)) {
        throw new Error(`path not in snapshot manifest: ${rel}`)
      }
    }
    paths = requested
  }

  const now = options.now ?? new Date()
  const safety = await createSnapshot(root, { trigger: `pre-restore:${id}`, now })
  const journal: RestoreJournal = {
    format: 1,
    snapshot_id: id,
    safety_snapshot_id: safety.id,
    mode,
    started_at: now.toISOString(),
    files: paths ?? manifest.files.map((file) => file.path),
    removed: [],
  }
  await writeRestoreJournal(root, journal)

  try {
    const applied = await applyManifest(root, id, manifest, paths, mode === "full")
    await clearRestoreJournal(root)
    return { id, mode, restored: applied.restored, removed: applied.removed, safetySnapshotId: safety.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const safetyManifest = await readSnapshotManifest(root, safety.id)
    if (safetyManifest) {
      try {
        await applyManifest(root, safety.id, safetyManifest, null, true)
      } catch (rollbackErr) {
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        throw new Error(
          `restore failed (${message}); rollback failed (${rollbackMessage}) — journal kept for recovery`,
        )
      }
    }
    await clearRestoreJournal(root)
    throw new Error(`restore failed and was rolled back: ${message}`)
  }
}

export interface RestoreRecovery {
  recovered: boolean
  safetySnapshotId: string | null
  error: string | null
}

// Rolls an interrupted restore back to the safety snapshot that the journal points at.
export async function recoverInterruptedRestore(root: string): Promise<RestoreRecovery> {
  const journal = await readRestoreJournal(root)
  if (!journal) {
    return { recovered: false, safetySnapshotId: null, error: null }
  }
  const safetyManifest = await readSnapshotManifest(root, journal.safety_snapshot_id)
  if (!safetyManifest) {
    return {
      recovered: false,
      safetySnapshotId: journal.safety_snapshot_id,
      error: "journal references an unreadable safety snapshot",
    }
  }
  try {
    await applyManifest(root, journal.safety_snapshot_id, safetyManifest, null, true)
    await clearRestoreJournal(root)
    return { recovered: true, safetySnapshotId: journal.safety_snapshot_id, error: null }
  } catch (err) {
    return {
      recovered: false,
      safetySnapshotId: journal.safety_snapshot_id,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
