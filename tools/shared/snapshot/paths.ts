import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import type { Dirent } from "node:fs"
import { atomicWriteFile, stripBom } from "../io"
import {
  RestoreJournalSchema,
  SnapshotDrillSchema,
  SnapshotPinSchema,
  type RestoreJournal,
  type SnapshotDrill,
  type SnapshotPin,
} from "../schemas"

// This module owns the layout of the snapshots directory together with the primitives that read it.
// Every other snapshot module depends on this one, so nothing here imports a sibling module.

const SNAPSHOTS_DIR_NAME = "snapshots"
const RESTORE_JOURNAL_NAME = ".restore-journal.json"
const PIN_FILE_NAME = ".pin.json"
const DRILL_FILE_NAME = ".drill.json"

const EXCLUDED_DIRS = [".opencode/backups", ".opencode/snapshots"]
const EXCLUDED_SUFFIXES = [".lock", ".tmp", ".bak", ".sha256"]

const CORE_FILES = [
  ".opencode/spec-memory/session.json",
  ".opencode/spec-memory/config.json",
  ".opencode/spec-memory/constitution.md",
  ".opencode/guard.json",
]

const OPTIONAL_FILES = [".opencode/domain-map.md"]

function toPosix(p: string): string {
  return p.split(path.sep).join("/")
}

// Keeps backups, snapshots and transient files out of the captured scope.
function isExcluded(relPath: string): boolean {
  const posix = toPosix(relPath)
  if (EXCLUDED_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) return true
  return EXCLUDED_SUFFIXES.some((suffix) => posix.endsWith(suffix))
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

// Walks a directory tree and collects the project relative paths that belong to a snapshot.
async function walkFiles(absDir: string, relBase: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => [] as Dirent[])
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (isExcluded(rel)) continue
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(abs, rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

// Stamps a date in local time because snapshot ids are read by humans sorting folders by name.
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// Turns a trigger into a filesystem safe slug so the folder name always reads well.
export function slugifyTrigger(trigger: string): string {
  const slug = trigger.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
  return slug || "snapshot"
}

export function snapshotsDirPath(root: string): string {
  return path.join(root, ".opencode", SNAPSHOTS_DIR_NAME)
}

export function restoreJournalPath(root: string): string {
  return path.join(snapshotsDirPath(root), RESTORE_JOURNAL_NAME)
}

export function pinPath(root: string, id: string): string {
  return path.join(snapshotsDirPath(root), id, PIN_FILE_NAME)
}

export function drillPath(root: string, id: string): string {
  return path.join(snapshotsDirPath(root), id, DRILL_FILE_NAME)
}

// Lists every file a snapshot captures, which is the core state plus features and steering documents.
export async function collectScope(root: string): Promise<string[]> {
  const files: string[] = []
  for (const rel of [...CORE_FILES, ...OPTIONAL_FILES]) {
    const abs = path.join(root, ...rel.split("/"))
    try {
      const stat = await fs.stat(abs)
      if (stat.isFile()) files.push(rel)
    } catch {
      // a missing core or optional file simply does not enter the scope
    }
  }
  await walkFiles(path.join(root, "specs"), "specs", files)
  await walkFiles(path.join(root, ".opencode", "steering"), ".opencode/steering", files)
  return files
}

// Refuses manifest paths that would escape the project root during a restore.
export function assertSafeManifestPath(rel: string): void {
  const unsafe =
    !rel ||
    rel.startsWith("/") ||
    rel.startsWith("\\") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.includes("\\") ||
    rel.split("/").some((segment) => segment === ".." || segment === "")
  if (unsafe) {
    throw new Error(`unsafe snapshot path: ${rel}`)
  }
}

// Reads the pin sidecar that marks a snapshot as a golden state that retention never removes.
export async function readPinInfo(root: string, id: string): Promise<SnapshotPin | null> {
  try {
    const raw = await fs.readFile(pinPath(root, id), "utf-8")
    const parsed = SnapshotPinSchema.safeParse(JSON.parse(stripBom(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// Reads the drill sidecar that records whether a snapshot was proved restorable in a sandbox.
export async function readDrillInfo(root: string, id: string): Promise<SnapshotDrill | null> {
  try {
    const raw = await fs.readFile(drillPath(root, id), "utf-8")
    const parsed = SnapshotDrillSchema.safeParse(JSON.parse(stripBom(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// Reads the journal that marks a restore that started and never finished.
export async function readRestoreJournal(root: string): Promise<RestoreJournal | null> {
  try {
    const raw = await fs.readFile(restoreJournalPath(root), "utf-8")
    const parsed = RestoreJournalSchema.safeParse(JSON.parse(stripBom(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeRestoreJournal(root: string, journal: RestoreJournal): Promise<void> {
  const parsed = RestoreJournalSchema.parse(journal)
  await atomicWriteFile(restoreJournalPath(root), JSON.stringify(parsed, null, 2))
}

export async function clearRestoreJournal(root: string): Promise<void> {
  await fs.rm(restoreJournalPath(root), { force: true })
}
