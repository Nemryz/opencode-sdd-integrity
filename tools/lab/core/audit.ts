import fs from "node:fs/promises"
import path from "node:path"
import { withLabLock } from "./fs"
import { labPaths } from "./home"
import type { LabIsolationProvider } from "./types"

export type LabAuditEventKind =
  | "lab_created"
  | "lab_run"
  | "lab_promoted"
  | "lab_destroyed"
  | "lab_pruned"
  | "lab_policy"
  | "lab_session_created"
  | "lab_session_closed"
  | "lab_checkpoint"
  | "lab_resume"
  | "lab_session_pruned"

export interface LabAuditEvent {
  kind: LabAuditEventKind
  projectRoot: string
  when: string
  sandboxId?: string
  isolationProvider?: LabIsolationProvider
  details?: Record<string, unknown>
}

// The file keeps one line per action, is append only and loses its write bit after every append.
export interface LabAuditRecord {
  kind: LabAuditEventKind
  when: string
  sandboxId?: string
  isolationProvider?: LabIsolationProvider
  details?: Record<string, unknown>
}

const DIRECTORY_PERMISSIONS = 0o700
const HOLD_PERMISSIONS = 0o400
const WRITE_PERMISSIONS = 0o600

function auditDirectory(projectRoot: string): string {
  return labPaths(projectRoot).audit
}

function auditFile(projectRoot: string): string {
  return path.join(auditDirectory(projectRoot), "lab-audit.jsonl")
}

function auditRecord(event: LabAuditEvent): LabAuditRecord {
  return {
    kind: event.kind,
    when: event.when,
    sandboxId: event.sandboxId,
    isolationProvider: event.isolationProvider,
    details: event.details,
  }
}

function auditLockFile(file: string): string {
  return path.join(path.dirname(file), ".audit.lock")
}

// Appends one line under a lock with retries, so concurrent writers and the Windows read only attribute never collide.
export async function appendAuditLine(file: string, line: string): Promise<void> {
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_PERMISSIONS })
  await fs.chmod(directory, DIRECTORY_PERMISSIONS).catch(() => undefined)
  await withLabLock(auditLockFile(file), async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Windows keeps the read only attribute from the last append, so the write bit goes back on before the open.
        await fs.chmod(file, WRITE_PERMISSIONS).catch(() => undefined)
        const handle = await fs.open(file, "a", WRITE_PERMISSIONS)
        try {
          await handle.writeFile(line, "utf-8")
        } finally {
          await handle.close()
        }
        await fs.chmod(file, HOLD_PERMISSIONS).catch(() => undefined)
        return
      } catch (error) {
        const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
    throw new Error(`The audit file could not be appended after retries: ${file}`)
  })
}

// Appends one audit line per lab action and keeps the audit file owned by the parent process.
export async function appendLabAudit(event: LabAuditEvent): Promise<string> {
  const file = auditFile(event.projectRoot)
  await appendAuditLine(file, `${JSON.stringify(auditRecord(event))}\n`)
  return file
}

// Reads the chronology in file order, which a run or a user review can print to reconstruct what happened.
export async function readLabAudit(projectRoot: string): Promise<LabAuditRecord[]> {
  const file = auditFile(projectRoot)
  let text: string
  try {
    text = await fs.readFile(file, "utf-8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LabAuditRecord)
}

export function labAuditFile(projectRoot: string): string {
  return auditFile(projectRoot)
}

export function formatLabAudit(records: LabAuditRecord[]): string {
  if (records.length === 0) return "No lab audit events yet."
  const lines = ["Lab audit trail", ""]
  for (const record of records) {
    const sandbox = record.sandboxId ? ` ${record.sandboxId}` : ""
    const provider = record.isolationProvider ? ` via ${record.isolationProvider}` : ""
    lines.push(`${record.when}  ${record.kind}${sandbox}${provider}`)
  }
  lines.push("", `Total events recorded: ${records.length}`)
  return lines.join("\n")
}
