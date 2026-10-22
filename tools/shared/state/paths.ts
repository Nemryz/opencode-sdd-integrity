// This module owns the transaction layout, the safe path checks and the content hashes that a state plan compares.

import crypto from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { atomicWriteFile } from "../atomic"
import { withLock } from "../locks"
import { isENOENT } from "../errors"
import { stripBom } from "../checksums"
import { StateJournalSchema, type StateJournal } from "../schemas"

const TRANSACTIONS_DIR = "transactions"
const JOURNAL_FILE = "journal.json"

export type PathTree =
  | { kind: "absent" }
  | { kind: "file"; sha256: string }
  | { kind: "dir"; entries: Array<{ path: string; sha256: string }> }

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

export function assertSafeRelativePath(rel: string): void {
  if (!rel || rel.includes("\0")) throw new Error(`unsafe state path: ${rel}`)
  if (rel.startsWith("/") || rel.startsWith("\\")) throw new Error(`unsafe state path: ${rel}`)
  if (/^[A-Za-z]:/.test(rel)) throw new Error(`unsafe state path: ${rel}`)
  if (rel.includes("\\")) throw new Error(`unsafe state path: ${rel}`)
  const segments = rel.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe state path: ${rel}`)
  }
}

export function resolveStatePath(root: string, rel: string): string {
  assertSafeRelativePath(rel)
  const resolved = path.resolve(root, ...rel.split("/"))
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`unsafe state path: ${rel}`)
  }
  return resolved
}

export async function assertNoSymlinkParents(root: string, rel: string): Promise<void> {
  assertSafeRelativePath(rel)
  const segments = rel.split("/")
  let current = path.resolve(root)
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`unsafe state path: ${rel}`)
      if (!stat.isDirectory()) throw new Error(`unsafe state path: ${rel}`)
    } catch (err) {
      if (isENOENT(err)) return
      throw err
    }
  }
}

export function toPosix(rel: string): string {
  return rel.split(path.sep).join("/")
}

export function isExcludedStatePath(rel: string): boolean {
  const posix = toPosix(rel)
  if (posix === ".opencode/backups" || posix.startsWith(".opencode/backups/")) return true
  if (posix === ".opencode/snapshots" || posix.startsWith(".opencode/snapshots/")) return true
  if (posix === ".opencode/transactions" || posix.startsWith(".opencode/transactions/")) return true
  return posix.endsWith(".lock") || posix.endsWith(".tmp") || posix.endsWith(".bak") || posix.endsWith(".sha256")
}

async function walkTree(
  absDir: string,
  relDir: string,
  entries: Array<{ path: string; sha256: string }>,
): Promise<void> {
  const listing = await fs.readdir(absDir, { withFileTypes: true })
  listing.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of listing) {
    const rel = `${relDir}/${entry.name}`
    if (isExcludedStatePath(rel)) continue
    const abs = path.join(absDir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`unsafe state path: ${rel}`)
    if (entry.isDirectory()) {
      await walkTree(abs, rel, entries)
      continue
    }
    if (entry.isFile()) {
      entries.push({ path: rel, sha256: sha256(await fs.readFile(abs)) })
    }
  }
}

export async function readPathTree(root: string, rel: string): Promise<PathTree> {
  await assertNoSymlinkParents(root, rel)
  const abs = resolveStatePath(root, rel)
  let stat
  try {
    stat = await fs.lstat(abs)
  } catch (err) {
    if (isENOENT(err)) return { kind: "absent" }
    throw err
  }
  if (stat.isSymbolicLink()) throw new Error(`unsafe state path: ${rel}`)
  if (stat.isFile()) return { kind: "file", sha256: sha256(await fs.readFile(abs)) }
  if (!stat.isDirectory()) throw new Error(`unsupported state path: ${rel}`)
  const entries: Array<{ path: string; sha256: string }> = []
  await walkTree(abs, rel, entries)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { kind: "dir", entries }
}

export async function hashPathTree(root: string, rel: string): Promise<string> {
  const tree = await readPathTree(root, rel)
  return tree.kind === "absent" ? "absent" : sha256(canonicalJson(tree))
}

export async function hashScope(root: string, scope: string[]): Promise<string> {
  const unique = [...new Set(scope)].sort()
  const entries: Array<{ path: string; hash: string }> = []
  for (const rel of unique) {
    entries.push({ path: rel, hash: await hashPathTree(root, rel) })
  }
  return sha256(canonicalJson(entries))
}

export function transactionsDirPath(root: string): string {
  return path.join(root, ".opencode", TRANSACTIONS_DIR)
}

export function stateLockPath(root: string): string {
  return path.join(transactionsDirPath(root), "state")
}

export function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withLock(stateLockPath(root), fn)
}

export function transactionDirPath(root: string, txId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(txId)) throw new Error(`unsafe transaction id: ${txId}`)
  return path.join(transactionsDirPath(root), txId)
}

export function journalPath(root: string, txId: string): string {
  return path.join(transactionDirPath(root, txId), JOURNAL_FILE)
}

export function transactionBackupPath(root: string, txId: string, rel: string): string {
  assertSafeRelativePath(rel)
  return path.join(transactionDirPath(root, txId), "backups", ...rel.split("/"))
}

export async function writeJournal(root: string, journal: StateJournal): Promise<void> {
  const parsed = StateJournalSchema.parse(journal)
  await fs.mkdir(path.dirname(journalPath(root, parsed.txId)), { recursive: true })
  await atomicWriteFile(journalPath(root, parsed.txId), JSON.stringify(parsed, null, 2))
}

export async function readJournal(root: string, txId: string): Promise<StateJournal | null> {
  try {
    const raw = await fs.readFile(journalPath(root, txId), "utf-8")
    const parsed = StateJournalSchema.safeParse(JSON.parse(stripBom(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function listTransactionIds(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(transactionsDirPath(root), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "state.lock")
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export async function clearTransaction(root: string, txId: string): Promise<void> {
  await fs.rm(transactionDirPath(root, txId), { recursive: true, force: true })
}
