import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type {
  LabCheckpoint,
  LabIsolationProvider,
  LabResume,
  LabSandbox,
  LabSession,
  LabSessionRegistry,
} from "./types"
import { isLabSessionStatus } from "./types"
import { makeLabId, readJson, withLabLock, writeJsonAtomic } from "./fs"
import { ensureLabHome, labPaths } from "./home"
import type { LabAuditEventKind, LabAuditRecord } from "./audit"
import { appendLabAudit } from "./audit"
import { collectPatch, headCommit } from "./git"
import { getSandbox, readRegistry } from "./registry"

const HOLD_PERMISSIONS = 0o400
const WRITE_PERMISSIONS = 0o600
const DIRECTORY_PERMISSIONS = 0o700
const SAFE_ID = /^[A-Za-z0-9._-]+$/
const CHECKPOINT_FILE = /^(\d+)\.json$/

function sessionsRoot(projectRoot: string): string {
  return labPaths(projectRoot).sessions
}

function sessionsRegistryFile(projectRoot: string): string {
  return path.join(sessionsRoot(projectRoot), "registry.json")
}

export function sessionLock(projectRoot: string): string {
  return path.join(sessionsRoot(projectRoot), ".lock")
}

export function sessionDir(projectRoot: string, sessionId: string): string {
  return path.join(sessionsRoot(projectRoot), sessionId)
}

function checkpointsDir(projectRoot: string, sessionId: string): string {
  return path.join(sessionDir(projectRoot, sessionId), "checkpoints")
}

export function checkpointFile(projectRoot: string, sessionId: string, index: number): string {
  return path.join(checkpointsDir(projectRoot, sessionId), `${index}.json`)
}

// Rebuilds the canonical payload without the stored integrity line, so a recompute proves the file was not edited.
function checkpointPayload(value: LabCheckpoint): Omit<LabCheckpoint, "integrity"> {
  return {
    schemaVersion: value.schemaVersion,
    index: value.index,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    sandboxId: value.sandboxId,
    sandboxHead: value.sandboxHead,
    patchHash: value.patchHash,
    runId: value.runId,
    runSummaryPath: value.runSummaryPath,
    note: value.note,
  }
}

export function checkpointIntegrity(value: LabCheckpoint): string {
  return crypto.createHash("sha256").update(JSON.stringify(checkpointPayload(value))).digest("hex")
}

async function ensureSessionDirs(projectRoot: string, sessionId: string): Promise<void> {
  const dir = sessionDir(projectRoot, sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.chmod(dir, DIRECTORY_PERMISSIONS)
  await fs.mkdir(checkpointsDir(projectRoot, sessionId), { recursive: true })
  await fs.chmod(checkpointsDir(projectRoot, sessionId), DIRECTORY_PERMISSIONS)
}

// Mirrors the global audit between one session and its own durable chronology file.
export interface LabSessionAuditEvent {
  kind: LabAuditEventKind
  projectRoot: string
  sessionId: string
  when: string
  sandboxId?: string
  isolationProvider?: LabIsolationProvider
  details?: Record<string, unknown>
}

export interface LabSessionAuditRecord extends LabAuditRecord {
  sessionId?: string
}

function sessionAuditRecord(event: LabSessionAuditEvent): LabSessionAuditRecord {
  return {
    kind: event.kind,
    when: event.when,
    sessionId: event.sessionId,
    sandboxId: event.sandboxId,
    isolationProvider: event.isolationProvider,
    details: event.details,
  }
}

export function sessionAuditFile(projectRoot: string, sessionId: string): string {
  return path.join(sessionDir(projectRoot, sessionId), "audit.jsonl")
}

// Appends one line to the session chronology and keeps the file read only between appends.
export async function appendSessionAudit(event: LabSessionAuditEvent): Promise<string> {
  const session = await getSession(event.projectRoot, event.sessionId)
  if (!session) {
    throw new Error(`Lab session ${event.sessionId} is not registered, so its chronology cannot be written`)
  }
  await ensureSessionDirs(event.projectRoot, event.sessionId)
  const file = sessionAuditFile(event.projectRoot, event.sessionId)
  await fs.chmod(file, WRITE_PERMISSIONS).catch(() => undefined)
  const line = `${JSON.stringify(sessionAuditRecord(event))}\n`
  const handle = await fs.open(file, "a", WRITE_PERMISSIONS)
  try {
    await handle.writeFile(line, "utf-8")
  } finally {
    await handle.close()
  }
  await fs.chmod(file, HOLD_PERMISSIONS)
  return file
}

// Reads the session chronology in file order so a review can reconstruct everything the session did.
export async function readSessionAudit(projectRoot: string, sessionId: string): Promise<LabSessionAuditRecord[]> {
  let text: string
  try {
    text = await fs.readFile(sessionAuditFile(projectRoot, sessionId), "utf-8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LabSessionAuditRecord)
}

function sanitizeSessionEntry(entry: LabSession, projectRoot: string, file: string): LabSession {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Lab session entry is not an object inside ${file}`)
  }
  if (typeof entry.id !== "string" || !SAFE_ID.test(entry.id)) {
    throw new Error(`Lab session entry carries an unsafe id inside ${file}`)
  }
  if (typeof entry.sandboxId !== "string" || !SAFE_ID.test(entry.sandboxId)) {
    throw new Error(`Lab session entry ${entry.id} carries an unsafe sandbox id inside ${file}`)
  }
  if (!isLabSessionStatus(entry.status)) {
    throw new Error(`Lab session entry ${entry.id} carries an unknown status inside ${file}`)
  }
  if (typeof entry.createdAt !== "string" || entry.createdAt.trim() === "" || typeof entry.updatedAt !== "string" || entry.updatedAt.trim() === "") {
    throw new Error(`Lab session entry ${entry.id} is missing its timestamps inside ${file}`)
  }
  if (typeof entry.checkpointCount !== "number" || !Number.isInteger(entry.checkpointCount) || entry.checkpointCount < 0) {
    throw new Error(`Lab session entry ${entry.id} carries an invalid checkpoint count inside ${file}`)
  }
  if (!Array.isArray(entry.warnings) || entry.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error(`Lab session entry ${entry.id} carries invalid warnings inside ${file}`)
  }
  // The reading process owns the root it was given, so a tampered entry can never repoint the layout.
  return {
    id: entry.id,
    projectRoot,
    sandboxId: entry.sandboxId,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    checkpointCount: entry.checkpointCount,
    label: entry.label,
    lastCheckpointAt: entry.lastCheckpointAt,
    lastRunId: entry.lastRunId,
    warnings: [...entry.warnings],
  }
}

export async function readSessions(projectRoot: string): Promise<LabSessionRegistry> {
  const file = sessionsRegistryFile(projectRoot)
  let parsed: LabSessionRegistry | null
  try {
    parsed = await readJson<LabSessionRegistry>(file)
  } catch {
    throw new Error(`Lab session registry is unreadable: ${file}`)
  }
  if (!parsed) return { version: 1, sessions: [] }
  if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new Error(`Lab session registry is unreadable: ${file}`)
  }
  return {
    version: 1,
    sessions: parsed.sessions.map((entry) => sanitizeSessionEntry(entry as LabSession, projectRoot, file)),
  }
}

export async function writeSessions(projectRoot: string, registry: LabSessionRegistry): Promise<void> {
  await writeJsonAtomic(sessionsRegistryFile(projectRoot), registry)
}

export interface CreateSessionOptions {
  projectRoot: string
  sandboxId: string
  label?: string
}

// Opens a persistent session for a live sandbox so checkpoint history can grow under .opencode/lab/sessions.
export async function createSession(options: CreateSessionOptions): Promise<LabSession> {
  const sandbox = await getSandbox(options.projectRoot, options.sandboxId)
  if (!sandbox) {
    throw new Error(`Lab sandbox ${options.sandboxId} is not registered, so no session can point at it`)
  }
  if (sandbox.status === "destroyed") {
    throw new Error(`Lab sandbox ${options.sandboxId} was destroyed, so a new sandbox is needed before a session opens`)
  }
  await ensureLabHome(options.projectRoot)
  const now = new Date().toISOString()
  const session: LabSession = {
    id: makeLabId(),
    projectRoot: options.projectRoot,
    sandboxId: options.sandboxId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    checkpointCount: 0,
    warnings: [],
  }
  if (options.label) session.label = options.label
  await withLabLock(sessionLock(options.projectRoot), async () => {
    const registry = await readSessions(options.projectRoot)
    registry.sessions.push(session)
    await writeSessions(options.projectRoot, registry)
  })
  await ensureSessionDirs(options.projectRoot, session.id)
  await appendLabAudit({
    kind: "lab_session_created",
    projectRoot: options.projectRoot,
    when: session.createdAt,
    sandboxId: options.sandboxId,
    isolationProvider: sandbox.provider,
    details: {
      sessionId: session.id,
      trust: sandbox.trust,
    },
  })
  await appendSessionAudit({
    kind: "lab_session_created",
    projectRoot: options.projectRoot,
    sessionId: session.id,
    when: session.createdAt,
    sandboxId: options.sandboxId,
    isolationProvider: sandbox.provider,
    details: {
      trust: sandbox.trust,
    },
  })
  return session
}

export async function listSessions(projectRoot: string): Promise<LabSession[]> {
  const registry = await readSessions(projectRoot)
  return [...registry.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getSession(projectRoot: string, id: string): Promise<LabSession | null> {
  const registry = await readSessions(projectRoot)
  return registry.sessions.find((entry) => entry.id === id) ?? null
}

export async function latestSession(projectRoot: string): Promise<LabSession | null> {
  const sessions = await listSessions(projectRoot)
  return sessions.find((entry) => entry.status === "active" || entry.status === "resumed") ?? null
}

export async function updateSession(
  projectRoot: string,
  id: string,
  patch: Partial<LabSession>,
): Promise<LabSession | null> {
  await ensureLabHome(projectRoot)
  return withLabLock(sessionLock(projectRoot), async () => {
    const registry = await readSessions(projectRoot)
    const index = registry.sessions.findIndex((entry) => entry.id === id)
    if (index === -1) return null
    const updated = { ...registry.sessions[index], ...patch, id }
    registry.sessions[index] = updated
    await writeSessions(projectRoot, registry)
    return updated
  })
}

// Updates the session entry without taking the lock again, so it only runs inside an existing session lock.
async function updateSessionRecord(projectRoot: string, id: string, patch: Partial<LabSession>): Promise<void> {
  const registry = await readSessions(projectRoot)
  const index = registry.sessions.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`Lab session ${id} disappeared while it was being updated`)
  registry.sessions[index] = { ...registry.sessions[index], ...patch, id }
  await writeSessions(projectRoot, registry)
}

export interface CreateCheckpointOptions {
  note?: string
  runId?: string
  runSummaryPath?: string
}

async function highestCheckpointIndex(projectRoot: string, sessionId: string): Promise<number> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(checkpointsDir(projectRoot, sessionId))
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
  let highest = 0
  for (const entry of entries) {
    const match = CHECKPOINT_FILE.exec(entry)
    if (!match) continue
    highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

// Freezes the sandbox HEAD and the staged patch hash into a tamper evident numbered checkpoint.
export async function createCheckpoint(
  projectRoot: string,
  sessionId: string,
  options: CreateCheckpointOptions = {},
): Promise<LabCheckpoint> {
  const session = await getSession(projectRoot, sessionId)
  if (!session) {
    throw new Error(`Lab session ${sessionId} is not registered, so it cannot take a checkpoint`)
  }
  if (session.status === "pruned" || session.status === "closed") {
    throw new Error(`Lab session ${sessionId} is ${session.status}, so a checkpoint needs an active session`)
  }
  const sandbox = await getSandbox(projectRoot, session.sandboxId)
  if (!sandbox) {
    throw new Error(`Lab session ${sessionId} points at sandbox ${session.sandboxId}, which is not registered anymore`)
  }
  if (sandbox.status === "destroyed") {
    throw new Error(`Lab session ${sessionId} cannot checkpoint because sandbox ${session.sandboxId} was destroyed`)
  }
  const patch = await collectPatch(sandbox.sandboxRoot)
  const patchHash = crypto.createHash("sha256").update(patch.patch).digest("hex")
  const sandboxHead = await headCommit(sandbox.sandboxRoot)
  await ensureSessionDirs(projectRoot, sessionId)
  const checkpoint = await withLabLock(sessionLock(projectRoot), async () => {
    const index = (await highestCheckpointIndex(projectRoot, sessionId)) + 1
    const now = new Date().toISOString()
    const record: LabCheckpoint = {
      schemaVersion: 1,
      index,
      createdAt: now,
      sessionId,
      sandboxId: session.sandboxId,
      sandboxHead,
      patchHash,
      integrity: "",
    }
    if (options.runId) record.runId = options.runId
    if (options.runSummaryPath) record.runSummaryPath = options.runSummaryPath
    if (options.note) record.note = options.note
    record.integrity = checkpointIntegrity(record)
    const file = checkpointFile(projectRoot, sessionId, index)
    await writeJsonAtomic(file, record)
    await fs.chmod(file, HOLD_PERMISSIONS)
    await updateSessionRecord(projectRoot, sessionId, {
      checkpointCount: index,
      lastCheckpointAt: now,
      updatedAt: now,
      ...(options.runId ? { lastRunId: options.runId } : {}),
    })
    return record
  })
  await appendLabAudit({
    kind: "lab_checkpoint",
    projectRoot,
    when: checkpoint.createdAt,
    sandboxId: session.sandboxId,
    isolationProvider: sandbox.provider,
    details: {
      sessionId,
      checkpointIndex: checkpoint.index,
      patchHash: checkpoint.patchHash,
      checkpointFile: checkpointFile(projectRoot, sessionId, checkpoint.index),
    },
  })
  await appendSessionAudit({
    kind: "lab_checkpoint",
    projectRoot,
    sessionId,
    when: checkpoint.createdAt,
    sandboxId: session.sandboxId,
    isolationProvider: sandbox.provider,
    details: {
      checkpointIndex: checkpoint.index,
      patchHash: checkpoint.patchHash,
    },
  })
  return checkpoint
}

// Reads the checkpoints of a session in order and fails loud on the first tampered file.
export async function readCheckpoints(projectRoot: string, sessionId: string): Promise<LabCheckpoint[]> {
  const session = await getSession(projectRoot, sessionId)
  if (!session) {
    throw new Error(`Lab session ${sessionId} is not registered, so it has no checkpoints`)
  }
  let entries: string[] = []
  try {
    entries = await fs.readdir(checkpointsDir(projectRoot, sessionId))
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const indexes: number[] = []
  for (const entry of entries) {
    const match = CHECKPOINT_FILE.exec(entry)
    if (match) indexes.push(Number(match[1]))
  }
  indexes.sort((a, b) => a - b)
  const checkpoints: LabCheckpoint[] = []
  for (const index of indexes) {
    checkpoints.push(await verifyCheckpoint(projectRoot, sessionId, index))
  }
  return checkpoints
}

export async function latestCheckpoint(projectRoot: string, sessionId: string): Promise<LabCheckpoint | null> {
  const checkpoints = await readCheckpoints(projectRoot, sessionId)
  return checkpoints.length === 0 ? null : checkpoints[checkpoints.length - 1]
}

// Recomputes the hash of a stored checkpoint so any in place edit fails loud instead of lying about the past.
export async function verifyCheckpoint(projectRoot: string, sessionId: string, index: number): Promise<LabCheckpoint> {
  const file = checkpointFile(projectRoot, sessionId, index)
  let parsed: LabCheckpoint | null
  try {
    parsed = await readJson<LabCheckpoint>(file)
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Lab checkpoint ${sessionId}/${index} is missing at ${file}`)
    }
    throw new Error(`Lab checkpoint ${sessionId}/${index} is unreadable at ${file}`)
  }
  if (!parsed) {
    throw new Error(`Lab checkpoint ${sessionId}/${index} is missing at ${file}`)
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Lab checkpoint ${sessionId}/${index} carries an unknown schema at ${file}`)
  }
  if (typeof parsed.integrity !== "string" || parsed.integrity.trim() === "") {
    throw new Error(`Lab checkpoint ${sessionId}/${index} is missing its integrity hash at ${file}`)
  }
  if (parsed.index !== index) {
    throw new Error(`Lab checkpoint ${sessionId}/${index} claims a different index at ${file}`)
  }
  if (parsed.integrity !== checkpointIntegrity({ ...parsed, integrity: "" })) {
    throw new Error(`Lab checkpoint ${sessionId}/${index} failed its integrity check because the file was edited after it was written`)
  }
  return parsed
}

export interface ResumeSessionOptions {
  sessionId?: string
}

// Reopens the most recent verifiable state of a session by proving the sandbox still holds the exact checked in state.
export async function resumeSession(projectRoot: string, options: ResumeSessionOptions = {}): Promise<LabResume> {
  await ensureLabHome(projectRoot)
  const session = options.sessionId
    ? await getSession(projectRoot, options.sessionId)
    : await latestSession(projectRoot)
  if (!session) {
    throw new Error(options.sessionId ? `Lab session ${options.sessionId} is not registered, so it cannot resume` : "The lab has no active session, so a session id is needed to resume")
  }
  if (session.status === "closed") {
    throw new Error(`Lab session ${session.id} is closed, so it cannot resume without being reopened`)
  }
  if (session.status === "pruned") {
    throw new Error(`Lab session ${session.id} was pruned, so checkpoints no longer exist`)
  }
  const sandbox = await getSandbox(projectRoot, session.sandboxId)
  if (!sandbox) {
    await closeSessionOnFailure(projectRoot, session, `Sandbox ${session.sandboxId} disappeared from the lab registry before resume`)
    throw new Error(`Lab session ${session.id} points at sandbox ${session.sandboxId}, which is not registered anymore, so the session closed`)
  }
  if (sandbox.status === "destroyed") {
    await closeSessionOnFailure(projectRoot, session, `Sandbox ${session.sandboxId} was destroyed before resume`)
    throw new Error(`Lab session ${session.id} cannot resume because sandbox ${session.sandboxId} was destroyed, so the session closed`)
  }
  try {
    await fs.lstat(sandbox.sandboxRoot)
  } catch {
    await closeSessionOnFailure(projectRoot, session, `Sandbox directory ${sandbox.sandboxRoot} is missing on disk before resume`)
    throw new Error(`Lab session ${session.id} cannot resume because the sandbox directory is missing on disk, so the session closed`)
  }
  const checkpoints = await readCheckpoints(projectRoot, session.id)
  if (checkpoints.length === 0) {
    throw new Error(`Lab session ${session.id} has no checkpoints yet, so there is nothing to resume`)
  }
  const checkpoint = checkpoints[checkpoints.length - 1]
  const currentHead = await headCommit(sandbox.sandboxRoot)
  if (currentHead !== checkpoint.sandboxHead) {
    throw new Error(`Lab sandbox ${sandbox.id} moved from commit ${checkpoint.sandboxHead} to ${currentHead} after the last checkpoint, so resume refused the drift; take a fresh checkpoint first`)
  }
  const patch = await collectPatch(sandbox.sandboxRoot)
  const patchHash = crypto.createHash("sha256").update(patch.patch).digest("hex")
  if (patchHash !== checkpoint.patchHash) {
    throw new Error(`Lab sandbox ${sandbox.id} drifted from the patch recorded by checkpoint ${checkpoint.index}, so resume refused it; take a fresh checkpoint first`)
  }
  const now = new Date().toISOString()
  const updated = await updateSession(projectRoot, session.id, {
    status: "resumed",
    updatedAt: now,
    warnings: [],
  })
  await appendLabAudit({
    kind: "lab_resume",
    projectRoot,
    when: now,
    sandboxId: sandbox.id,
    isolationProvider: sandbox.provider,
    details: {
      sessionId: session.id,
      checkpointIndex: checkpoint.index,
      patchHash: checkpoint.patchHash,
      sandboxHead: checkpoint.sandboxHead,
    },
  })
  await appendSessionAudit({
    kind: "lab_resume",
    projectRoot,
    sessionId: session.id,
    when: now,
    sandboxId: sandbox.id,
    isolationProvider: sandbox.provider,
    details: {
      checkpointIndex: checkpoint.index,
      patchHash: checkpoint.patchHash,
      sandboxHead: checkpoint.sandboxHead,
    },
  })
  return {
    session: updated ?? session,
    sandbox,
    checkpoint,
    resumedAt: now,
  }
}

// Closes a session whose sandbox can no longer prove its state, so the registry never advertises an unreachable session.
async function closeSessionOnFailure(projectRoot: string, session: LabSession, message: string): Promise<void> {
  const now = new Date().toISOString()
  await updateSession(projectRoot, session.id, {
    status: "closed",
    updatedAt: now,
    warnings: [...session.warnings, message],
  })
  await appendSessionAudit({
    kind: "lab_session_closed",
    projectRoot,
    sessionId: session.id,
    when: now,
    sandboxId: session.sandboxId,
    details: {
      warning: message,
    },
  })
}

export interface LabSessionPruneOptions {
  projectRoot: string
  olderThanDays?: number
  confirmed?: boolean
  now?: Date
}

export interface LabSessionPruneCandidate {
  id: string
  reason: "expired" | "orphan-directory" | "corrupt" | "dead-sandbox" | "missing-directory"
  action: "remove-session" | "remove-directory" | "close-session"
  path?: string
  ageDays?: number
  detail?: string
}

export interface LabSessionPruneResult {
  dryRun: boolean
  olderThanDays: number
  candidates: LabSessionPruneCandidate[]
  removed: string[]
  closed: string[]
  orphanDirectories: string[]
}

// Verifies every stored checkpoint and reports the first corruption found, so prune can quarantine the session.
async function sessionCorruptionReasons(projectRoot: string, sessionId: string): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(checkpointsDir(projectRoot, sessionId))
  } catch {
    return []
  }
  const reasons: string[] = []
  for (const entry of entries) {
    const match = CHECKPOINT_FILE.exec(entry)
    if (!match) continue
    try {
      await verifyCheckpoint(projectRoot, sessionId, Number(match[1]))
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error))
    }
  }
  return reasons
}

// Reclaims session storage by deleting expired or corrupt history and by closing sessions that lost their sandbox.
export async function pruneSessions(options: LabSessionPruneOptions): Promise<LabSessionPruneResult> {
  const olderThanDays = options.olderThanDays ?? 30
  const dryRun = options.confirmed !== true
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000
  const root = sessionsRoot(options.projectRoot)

  const candidates: LabSessionPruneCandidate[] = []
  const toRemove: LabSession[] = []
  const toClose: Array<{ session: LabSession, warning: string }> = []
  const orphanDirectories: string[] = []

  await withLabLock(sessionLock(options.projectRoot), async () => {
    const registry = await readSessions(options.projectRoot)
    const known = new Set(registry.sessions.map((entry) => entry.id))
    const sandboxes = await readRegistry(options.projectRoot)

    for (const session of registry.sessions) {
      let directoryExists = true
      try {
        await fs.lstat(sessionDir(options.projectRoot, session.id))
      } catch {
        directoryExists = false
      }
      const ageValue = session.lastCheckpointAt ?? session.updatedAt
      const parsedAge = Date.parse(ageValue)
      const ageDaysValue = Number.isNaN(parsedAge) ? 0 : Math.max(0, Math.floor((now.getTime() - parsedAge) / (24 * 60 * 60 * 1000)))
      const expired = !Number.isNaN(parsedAge) && parsedAge <= cutoff

      const sandbox = sandboxes.sandboxes.find((entry) => entry.id === session.sandboxId)
      let sandboxAlive = false
      if (sandbox && sandbox.status !== "destroyed") {
        sandboxAlive = true
        try {
          await fs.lstat(sandbox.sandboxRoot)
        } catch {
          sandboxAlive = false
        }
      }

      const corruption = directoryExists ? await sessionCorruptionReasons(options.projectRoot, session.id) : []
      if (corruption.length > 0) {
        toRemove.push(session)
        candidates.push({
          id: session.id,
          reason: "corrupt",
          action: "remove-session",
          path: sessionDir(options.projectRoot, session.id),
          ageDays: ageDaysValue,
          detail: corruption[0],
        })
        continue
      }
      if (!directoryExists) {
        if (expired) {
          toRemove.push(session)
          candidates.push({ id: session.id, reason: "expired", action: "remove-session", ageDays: ageDaysValue })
        } else {
          toClose.push({ session, warning: `Session directory is missing on disk at prune time` })
          candidates.push({
            id: session.id,
            reason: "missing-directory",
            action: "close-session",
            ageDays: ageDaysValue,
          })
        }
        continue
      }
      if (expired) {
        toRemove.push(session)
        candidates.push({
          id: session.id,
          reason: "expired",
          action: "remove-session",
          path: sessionDir(options.projectRoot, session.id),
          ageDays: ageDaysValue,
        })
        continue
      }
      if (!sandboxAlive) {
        toClose.push({
          session,
          warning: sandbox ? `Sandbox ${sandbox.id} was destroyed or lost its directory before session prune` : `Sandbox ${session.sandboxId} is not registered anymore before session prune`,
        })
        candidates.push({ id: session.id, reason: "dead-sandbox", action: "close-session", ageDays: ageDaysValue })
      }
    }

    let rootEntries: string[] = []
    try {
      rootEntries = await fs.readdir(root)
    } catch {
      rootEntries = []
    }
    const removeIds = new Set(toRemove.map((entry) => entry.id))
    for (const entry of rootEntries) {
      if (entry === "registry.json" || entry === ".lock") continue
      if (known.has(entry)) continue
      if (!SAFE_ID.test(entry)) continue
      orphanDirectories.push(path.join(root, entry))
      candidates.push({
        id: entry,
        reason: "orphan-directory",
        action: "remove-directory",
        path: path.join(root, entry),
      })
    }

    if (dryRun) return

    for (const item of toClose) {
      const index = registry.sessions.findIndex((entry) => entry.id === item.session.id)
      if (index === -1) continue
      const existing = registry.sessions[index]
      registry.sessions[index] = {
        ...existing,
        status: "closed",
        updatedAt: now.toISOString(),
        warnings: [...existing.warnings, item.warning],
      }
    }
    registry.sessions = registry.sessions.filter((entry) => !removeIds.has(entry.id))
    await writeSessions(options.projectRoot, registry)
  })

  if (dryRun) {
    return {
      dryRun: true,
      olderThanDays,
      candidates,
      removed: [],
      closed: [],
      orphanDirectories,
    }
  }

  const removed = toRemove.map((entry) => entry.id)
  for (const session of toRemove) {
    await fs.rm(sessionDir(options.projectRoot, session.id), { recursive: true, force: true }).catch(() => null)
  }
  for (const dir of orphanDirectories) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => null)
  }

  await appendLabAudit({
    kind: "lab_session_pruned",
    projectRoot: options.projectRoot,
    when: now.toISOString(),
    isolationProvider: "n/a",
    details: {
      removed,
      closed: toClose.map((item) => item.session.id),
      orphanDirectories,
      olderThanDays,
    },
  })

  return {
    dryRun: false,
    olderThanDays,
    candidates,
    removed,
    closed: toClose.map((item) => item.session.id),
    orphanDirectories,
  }
}
