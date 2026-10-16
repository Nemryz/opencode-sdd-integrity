import fs from "node:fs/promises"
import path from "node:path"
import type { Dirent } from "node:fs"
import { atomicWriteFile, stripBom } from "../io"
import { SnapshotManifestSchema, type SnapshotManifest } from "../schemas"
import {
  collectScope,
  formatTimestamp,
  pathExists,
  readDrillInfo,
  readPinInfo,
  sha256,
  slugifyTrigger,
  snapshotsDirPath,
} from "./paths"

// This module owns the manifest lifecycle, meaning creation, reading, verification and listing.

export interface CreateSnapshotOptions {
  trigger: string
  feature?: string | null
  phase?: string | null
  now?: Date
}

// Copies the whole scope into a new folder and keeps it only when the copies verify against the manifest.
export async function createSnapshot(root: string, options: CreateSnapshotOptions): Promise<SnapshotManifest> {
  const now = options.now ?? new Date()
  const baseId = `${formatTimestamp(now)}-${slugifyTrigger(options.trigger)}`
  const dir = snapshotsDirPath(root)
  await fs.mkdir(dir, { recursive: true })

  let id = baseId
  let counter = 2
  while (await pathExists(path.join(dir, id))) {
    id = `${baseId}-${counter}`
    counter++
  }
  const snapshotDir = path.join(dir, id)

  try {
    const relPaths = await collectScope(root)
    const files: SnapshotManifest["files"] = []
    for (const rel of relPaths) {
      const content = await fs.readFile(path.join(root, ...rel.split("/")))
      const dest = path.join(snapshotDir, ...rel.split("/"))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, content)
      files.push({ path: rel, size: content.byteLength, sha256: sha256(content) })
    }

    const manifest = SnapshotManifestSchema.parse({
      format: 1,
      id,
      created_at: now.toISOString(),
      trigger: options.trigger,
      feature: options.feature ?? null,
      phase: options.phase ?? null,
      files,
    })

    await atomicWriteFile(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2))

    const verification = await verifySnapshot(root, id)
    if (!verification.ok) {
      throw new Error(`snapshot verification failed for ${id}`)
    }
    return manifest
  } catch (err) {
    await fs.rm(snapshotDir, { recursive: true, force: true })
    throw err instanceof Error ? err : new Error(String(err))
  }
}

export async function readSnapshotManifest(root: string, id: string): Promise<SnapshotManifest | null> {
  try {
    const raw = await fs.readFile(path.join(snapshotsDirPath(root), id, "manifest.json"), "utf-8")
    const parsed = SnapshotManifestSchema.safeParse(JSON.parse(stripBom(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface SnapshotVerification {
  id: string
  ok: boolean
  error: string | null
  manifest: SnapshotManifest | null
  entries: Array<{ path: string; status: "ok" | "mismatch" | "missing" }>
}

// Recomputes the hash of every copied file so tampering or truncation becomes visible.
export async function verifySnapshot(root: string, id: string): Promise<SnapshotVerification> {
  const manifest = await readSnapshotManifest(root, id)
  if (!manifest) {
    return { id, ok: false, error: "manifest unreadable", manifest: null, entries: [] }
  }
  const entries: SnapshotVerification["entries"] = []
  for (const file of manifest.files) {
    const abs = path.join(snapshotsDirPath(root), id, ...file.path.split("/"))
    try {
      const content = await fs.readFile(abs)
      entries.push({ path: file.path, status: sha256(content) === file.sha256 ? "ok" : "mismatch" })
    } catch {
      entries.push({ path: file.path, status: "missing" })
    }
  }
  const ok = entries.every((entry) => entry.status === "ok")
  return { id, ok, error: null, manifest, entries }
}

export interface SnapshotListEntry {
  id: string
  createdAt: string | null
  trigger: string | null
  feature: string | null
  fileCount: number
  totalSize: number
  status: "verified" | "mismatched" | "unreadable"
  pinned: boolean
  label: string | null
  drill: "ok" | "failed" | "never"
}

// Lists every snapshot newest first and joins each one with its verification, pin and drill state.
export async function listSnapshots(root: string): Promise<SnapshotListEntry[]> {
  const dir = snapshotsDirPath(root)
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
  const entries: SnapshotListEntry[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const id = dirent.name
    const verification = await verifySnapshot(root, id)
    const pin = await readPinInfo(root, id)
    const drill = await readDrillInfo(root, id)
    const drillStatus: SnapshotListEntry["drill"] = drill === null ? "never" : drill.ok ? "ok" : "failed"
    if (!verification.manifest) {
      entries.push({
        id,
        createdAt: null,
        trigger: null,
        feature: null,
        fileCount: 0,
        totalSize: 0,
        status: "unreadable",
        pinned: pin !== null,
        label: pin?.label ?? null,
        drill: drillStatus,
      })
      continue
    }
    const totalSize = verification.manifest.files.reduce((sum, file) => sum + file.size, 0)
    entries.push({
      id,
      createdAt: verification.manifest.created_at,
      trigger: verification.manifest.trigger,
      feature: verification.manifest.feature,
      fileCount: verification.manifest.files.length,
      totalSize,
      status: verification.ok ? "verified" : "mismatched",
      pinned: pin !== null,
      label: pin?.label ?? null,
      drill: drillStatus,
    })
  }
  entries.sort((a, b) => b.id.localeCompare(a.id))
  return entries
}
