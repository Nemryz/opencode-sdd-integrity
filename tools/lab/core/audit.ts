import fs from "node:fs/promises"
import path from "node:path"
import { labPaths } from "./home"
import type { LabIsolationProvider } from "./types"

export type LabAuditEventKind =
  | "lab_created"
  | "lab_run"
  | "lab_promoted"
  | "lab_destroyed"
  | "lab_pruned"
  | "lab_policy"

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

// Appends one audit line per lab action and keeps the audit file owned by the parent process.
export async function appendLabAudit(event: LabAuditEvent): Promise<string> {
  const directory = auditDirectory(event.projectRoot)
  const file = auditFile(event.projectRoot)
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_PERMISSIONS })
  await fs.chmod(directory, DIRECTORY_PERMISSIONS)
  await fs.chmod(file, WRITE_PERMISSIONS).catch(() => undefined)
  const line = `${JSON.stringify(auditRecord(event))}\n`
  const handle = await fs.open(file, "a", WRITE_PERMISSIONS)
  try {
    await handle.writeFile(line, "utf-8")
  } finally {
    await handle.close()
  }
  await fs.chmod(file, HOLD_PERMISSIONS)
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
