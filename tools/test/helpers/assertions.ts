import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "vitest"
import { readRestoreJournal, snapshotsDirPath } from "../../shared/snapshot/paths"
import { listSnapshots } from "../../shared/snapshot/manifest"
import {
  readSession,
  readSpecJson,
  specsDirPath,
  SessionStateSchema,
  SpecJsonSchema,
} from "../../shared/types"
import type { SessionState, SpecJson } from "../../shared/types"

type ParserLike = {
  safeParse: (data: unknown) => { success: boolean }
}

// Builds the absolute path of a project relative file so tests never assemble paths by hand.
// Both separator styles are accepted because fixtures are written with forward slashes and
// occasionally with the Windows style, and a POSIX join would keep backslashes as literal names.
export function projectPath(worktree: string, relPath: string): string {
  return path.join(worktree, ...relPath.split(/[\\/]/))
}

// Writes a file inside the temp worktree and creates the parent folders when they are missing.
export async function writeProjectFile(worktree: string, relPath: string, content: string): Promise<void> {
  const abs = projectPath(worktree, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

// Reads a file from the temp worktree and fails with the relative path when it cannot be read.
export async function readProjectFile(worktree: string, relPath: string): Promise<string> {
  try {
    return await fs.readFile(projectPath(worktree, relPath), "utf-8")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`cannot read ${relPath} (${message})`)
  }
}

// Reads and parses a JSON file from disk so assertions work on real data and not on tool output.
export async function readProjectJson<T = unknown>(worktree: string, relPath: string): Promise<T> {
  const raw = await readProjectFile(worktree, relPath)
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T
}

// Asserts that a file exists on disk and reports its relative path when it does not.
export async function expectFileExists(worktree: string, relPath: string): Promise<void> {
  const stat = await fs.stat(projectPath(worktree, relPath)).catch(() => null)
  expect(stat, `expected file to exist ${relPath}`).not.toBeNull()
  expect(stat?.isFile(), `expected a file at ${relPath}`).toBe(true)
}

// Asserts that a path is absent from disk so deletions can be asserted like any other change.
export async function expectPathMissing(worktree: string, relPath: string): Promise<void> {
  const stat = await fs.stat(projectPath(worktree, relPath)).catch(() => null)
  expect(stat, `expected path to be absent ${relPath}`).toBeNull()
}

// Compares the bytes stored on disk with the expected content of a file.
export async function expectFileContent(worktree: string, relPath: string, expected: string): Promise<void> {
  expect(await readProjectFile(worktree, relPath)).toBe(expected)
}

// Validates any object against a Zod schema so tests assert the contract and not just the shape.
export function expectSchemaValid(schema: ParserLike, value: unknown): void {
  const result = schema.safeParse(value)
  expect(result.success, "value does not satisfy the schema").toBe(true)
}

// Asserts a valid session.json on disk and matches the expected fields inside it.
export async function expectSessionState(
  worktree: string,
  expected: Partial<SessionState>,
): Promise<SessionState> {
  const session = await readSession(worktree)
  expectSchemaValid(SessionStateSchema, session)
  for (const [field, value] of Object.entries(expected)) {
    expect(session, `session field ${field}`).toMatchObject({ [field]: value })
  }
  return session
}

// Asserts a valid spec.json on disk for a feature and matches the expected fields inside it.
export async function expectFeatureSpecJson(
  worktree: string,
  featureDir: string,
  expected: Partial<SpecJson>,
): Promise<SpecJson | null> {
  const specJson = await readSpecJson(path.join(specsDirPath(worktree), featureDir))
  expect(specJson, `expected spec.json for ${featureDir}`).not.toBeNull()
  expectSchemaValid(SpecJsonSchema, specJson)
  for (const [field, value] of Object.entries(expected)) {
    expect(specJson, `spec.json field ${field}`).toMatchObject({ [field]: value })
  }
  return specJson
}

// Lists snapshot ids ordered from newest to oldest so retention assertions can talk about position.
export async function listSnapshotIds(worktree: string): Promise<string[]> {
  const entries = await listSnapshots(worktree)
  return entries.map(entry => entry.id)
}

// Lists the trigger of every snapshot so automatic triggers can be asserted by name.
export async function listSnapshotTriggers(worktree: string): Promise<string[]> {
  const entries = await listSnapshots(worktree)
  return entries.map(entry => entry.trigger ?? "")
}

// Counts checksum guarded backups stored for a file so rewrite protection can be asserted.
export async function countBackupsFor(worktree: string, relPath: string): Promise<number> {
  const backupDir = path.join(worktree, ".opencode", "backups")
  const sourceKey = `${path.basename(relPath)}`
  const files = await fs.readdir(backupDir).catch(() => [] as string[])
  return files.filter(file => file.startsWith(`${sourceKey}.`) && file.endsWith(".bak")).length
}

// Asserts whether a restore journal is pending so interrupted restores can be asserted in tests.
export async function expectRestoreJournal(worktree: string, pending: boolean): Promise<void> {
  const journal = await readRestoreJournal(worktree)
  expect(journal !== null, `restore journal pending expected ${pending}`).toBe(pending)
}

// Returns the absolute snapshots directory so chaos tests can replace it with a blocking file.
export function snapshotDir(worktree: string): string {
  return snapshotsDirPath(worktree)
}