import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { ensureLabHome } from "./home"
import { readJson, writeTextAtomic } from "./fs"
import { appendLabAudit } from "./audit"
import { getSession, sessionDir } from "./session"
import { runDir } from "./registry"

// Raw files longer than this become a one line descriptor, so the bundle stays small while its identity survives.
const COMPACT_DETAIL_BYTES = 400

export interface LabCompactionFile {
  name: string
  kind: "replaced" | "preserved"
  bytesIn: number
  bytesOut: number
}

export interface LabCompactionReport {
  compacted: boolean
  when: string
  bytesFreed: number
  files: LabCompactionFile[]
  sessionId?: string
  runId?: string
}

export function compactionFile(projectRoot: string, bundleDir: string): string {
  return path.join(bundleDir, "compaction.json")
}

interface LabCompactionState {
  compacted: boolean
  when: string
  files: LabCompactionFile[]
}

async function loadState(file: string): Promise<LabCompactionState | null> {
  return readJson<LabCompactionState>(file)
}

async function writeState(file: string, state: LabCompactionState): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}

// Compacts one raw log line, keeping its shape, kind, session and status fields and shrinking every long detail string into a hash.
function compactAuditLine(line: string): string {
  const trimmed = line.trim()
  if (trimmed === "") return ""
  const hashed = (value: string): string => `Lab compacted detail value. Original bytes: ${value.length}. sha256: ${crypto.createHash("sha256").update(value).digest("hex")}`
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return `Lab compacted unreadable line. Original bytes: ${Buffer.byteLength(trimmed)}. sha256: ${crypto.createHash("sha256").update(trimmed).digest("hex")}\n`
  }
  const compacted: Record<string, unknown> = {}
  for (const key of ["kind", "sessionId", "sandboxId", "when", "status"]) {
    if (typeof parsed[key] === "string") compacted[key] = parsed[key]
  }
  const details = parsed.details
  if (details && typeof details === "object") {
    const compactedDetails: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(details)) {
      compactedDetails[key] = typeof value === "string" && value.length > COMPACT_DETAIL_BYTES ? hashed(value) : value
    }
    if (Object.keys(compactedDetails).length > 0) compacted.details = compactedDetails
  }
  return `${JSON.stringify(compacted)}\n`
}

// Journals a compaction to the audit with the inventory of what changed and how many bytes it freed.
async function journalCompaction(
  projectRoot: string,
  event: { sandboxId: string, sessionId?: string, runId?: string, files: LabCompactionFile[] },
): Promise<LabCompactionReport> {
  const when = new Date().toISOString()
  const bytesFreed = event.files.reduce((total, file) => total + Math.max(file.bytesIn - file.bytesOut, 0), 0)
  await appendLabAudit({
    kind: "lab_compacted",
    projectRoot,
    when,
    sandboxId: event.sandboxId,
    details: {
      sessionId: event.sessionId,
      runId: event.runId,
      compactedFiles: event.files.filter((file) => file.kind === "replaced").map((file) => file.name),
      bytesFreed,
    },
  })
  return {
    compacted: true,
    when,
    bytesFreed,
    files: event.files,
    sessionId: event.sessionId,
    runId: event.runId,
  }
}

async function summarizeFile(name: string, file: string, kind: "replaced" | "preserved"): Promise<LabCompactionFile> {
  const stat = await fs.lstat(file)
  return { name, kind, bytesIn: stat.size, bytesOut: stat.size }
}

// Compacts the bulky payload of a session bundle. Checkpoints stay untouched because their integrity depends on their bytes, and the provenance sidecar is out of reach on purpose.
export async function compactSessionBundle(projectRoot: string, sessionId: string): Promise<LabCompactionReport> {
  await ensureLabHome(projectRoot)
  const session = await getSession(projectRoot, sessionId)
  if (!session) throw new Error(`Lab session ${sessionId} is not registered, so there is no session bundle to compact`)
  const dir = sessionDir(projectRoot, sessionId)
  const stateFile = compactionFile(projectRoot, dir)
  const state = await loadState(stateFile)
  if (state?.compacted) {
    return { compacted: false, when: state.when, bytesFreed: 0, files: [], sessionId }
  }
  const auditPath = path.join(dir, "audit.jsonl")
  const audit = await fs.readFile(auditPath, "utf-8").catch(() => null)
  const files: LabCompactionFile[] = []
  if (audit) {
    const compacted = audit.split("\n").map((line) => compactAuditLine(line)).join("\n")
    const bytesIn = Buffer.byteLength(audit)
    const bytesOut = Buffer.byteLength(compacted)
    if (bytesOut < bytesIn) {
      await writeTextAtomic(auditPath, compacted)
      files.push({ name: "audit.jsonl", kind: "replaced", bytesIn, bytesOut })
    }
  }
  await writeState(stateFile, { compacted: true, when: new Date().toISOString(), files })
  return journalCompaction(projectRoot, { sandboxId: session.sandboxId, sessionId, files })
}

// Compacts the raw step logs and flake artifacts of a run bundle. The run summary keeps every id and summary, so the provenance graph still resolves after the compaction.
export async function compactRunBundle(projectRoot: string, sandboxId: string, runId: string): Promise<LabCompactionReport> {
  await ensureLabHome(projectRoot)
  const dir = runDir(projectRoot, sandboxId, runId)
  const stateFile = compactionFile(projectRoot, dir)
  const state = await loadState(stateFile)
  if (state?.compacted) {
    return { compacted: false, when: state.when, bytesFreed: 0, files: [], runId }
  }
  const entries = (await fs.readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b))
  const files: LabCompactionFile[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry)
    const stat = await fs.lstat(file).catch(() => null)
    if (!stat || !stat.isFile()) continue
    const isTarget = /^step-\d+\.log$/.test(entry) || entry === "flakes.json" || entry === "flakes.md"
    if (isTarget && stat.size >= COMPACT_DETAIL_BYTES) {
      const text = await fs.readFile(file, "utf-8")
      const descriptor = `Lab compacted file ${entry} on ${new Date().toISOString()}. Original bytes: ${stat.size}. sha256: ${crypto.createHash("sha256").update(text).digest("hex")}\n`
      await fs.writeFile(file, descriptor, "utf-8")
      files.push({ name: entry, kind: "replaced", bytesIn: stat.size, bytesOut: Buffer.byteLength(descriptor) })
    } else {
      files.push(await summarizeFile(entry, file, "preserved"))
    }
  }
  await writeState(stateFile, { compacted: true, when: new Date().toISOString(), files })
  return journalCompaction(projectRoot, { sandboxId, runId, files })
}

export function formatCompactionReport(report: LabCompactionReport): string {
  const lines = [`Lab compaction: ${report.compacted ? "compacted" : "already compacted or nothing to do"} at ${report.when}`]
  for (const file of report.files) {
    const freed = file.kind === "replaced" ? `freed ${file.bytesIn - file.bytesOut} bytes` : `kept at ${file.bytesOut} bytes`
    lines.push(`  ${file.kind} ${file.name} (${freed})`)
  }
  return lines.join("\n")
}
