import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { LabRunSummary, LabSandbox } from "./types"
import { isLabEntityId } from "./identity"
import { labPaths, ensureLabHome } from "./home"
import { appendAuditLine, appendLabAudit } from "./audit"
import { withLabLock } from "./fs"
import { isRunDirectory, readRunIndex, readRunSummaryFresh } from "./registry"
import { headCommit, collectPatch } from "./git"
import { readSessions, latestCheckpoint } from "./session"

// A baseline goes stale once this many newer runs exist for its sandbox.
export const STALE_BASELINE_RUNS = 3

export type LabStaleEntityKind = "run" | "patch" | "evidence" | "baseline" | "checkpoint"

const ENTITY_KINDS: LabStaleEntityKind[] = ["run", "patch", "evidence", "baseline", "checkpoint"]

export interface LabStaleFinding {
  entityId: string
  entityKind: LabStaleEntityKind
  reason: string
  detectedAt: string
}

export interface LabStaleRecord {
  kind: "stale"
  when: string
  entityId: string
  entityKind: LabStaleEntityKind
  reason: string
}

export function stalenessDir(projectRoot: string): string {
  return labPaths(projectRoot).staleness
}

export function stalenessFile(projectRoot: string, sandboxId: string): string {
  if (!isLabEntityId(sandboxId)) {
    throw new Error(`Lab staleness needs a safe sandbox id, received ${JSON.stringify(sandboxId)}`)
  }
  return path.join(stalenessDir(projectRoot), `${sandboxId}.jsonl`)
}

function stalenessLock(projectRoot: string, sandboxId: string): string {
  return path.join(stalenessDir(projectRoot), `${sandboxId}.lock`)
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function validateFinding(finding: LabStaleFinding, sandboxId: string): void {
  if (typeof finding.entityId !== "string" || finding.entityId.trim() === "" || /[\r\n]/.test(finding.entityId)) {
    throw new Error(`Lab staleness for sandbox ${sandboxId} carries an unsafe entity id`)
  }
  if (!ENTITY_KINDS.includes(finding.entityKind)) {
    throw new Error(`Lab staleness for sandbox ${sandboxId} carries an unknown entity kind ${JSON.stringify(finding.entityKind)}`)
  }
  if (typeof finding.reason !== "string" || finding.reason.trim() === "" || /[\r\n]/.test(finding.reason)) {
    throw new Error(`Lab staleness for sandbox ${sandboxId} carries an empty reason`)
  }
}

// Reads the stale journal in file order and fails loud on the first malformed line.
export async function readStaleJournal(projectRoot: string, sandboxId: string): Promise<LabStaleRecord[]> {
  let text: string
  try {
    text = await fs.readFile(stalenessFile(projectRoot, sandboxId), "utf-8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const records: LabStaleRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const parsed = JSON.parse(line) as Partial<LabStaleRecord>
    if (!parsed || parsed.kind !== "stale") {
      throw new Error(`Lab staleness line for sandbox ${sandboxId} is not a stale record`)
    }
    if (!ENTITY_KINDS.includes(parsed.entityKind as LabStaleEntityKind)) {
      throw new Error(`Lab staleness line for sandbox ${sandboxId} carries an unknown entity kind`)
    }
    if (typeof parsed.entityId !== "string" || parsed.entityId.trim() === "" || /[\r\n]/.test(parsed.entityId)) {
      throw new Error(`Lab staleness line for sandbox ${sandboxId} carries an unsafe entity id`)
    }
    if (typeof parsed.reason !== "string" || parsed.reason.trim() === "" || /[\r\n]/.test(parsed.reason)) {
      throw new Error(`Lab staleness line for sandbox ${sandboxId} carries an empty reason`)
    }
    if (typeof parsed.when !== "string" || parsed.when.trim() === "") {
      throw new Error(`Lab staleness line for sandbox ${sandboxId} is missing its timestamp`)
    }
    records.push({ kind: "stale", when: parsed.when, entityId: parsed.entityId, entityKind: parsed.entityKind as LabStaleEntityKind, reason: parsed.reason })
  }
  return records
}

// Evaluates every staleness condition live, so the answer always reflects the disk as it is now.
export async function detectStaleEvidence(projectRoot: string, sandbox: LabSandbox): Promise<LabStaleFinding[]> {
  if (sandbox.status === "destroyed") return []
  try {
    await fs.lstat(sandbox.sandboxRoot)
  } catch {
    return []
  }
  const findings: LabStaleFinding[] = []
  const now = new Date().toISOString()
  const runsDir = path.join(labPaths(projectRoot).reports, sandbox.id, "runs")
  let runIds: string[] = []
  try {
    const found = await fs.readdir(runsDir)
    for (const entry of found.sort((a, b) => a.localeCompare(b))) {
      if (!(await isRunDirectory(runsDir, entry))) continue
      runIds.push(entry)
    }
  } catch {
    runIds = []
  }

  const currentHead = await headCommit(sandbox.repoRoot)
  const summaries: LabRunSummary[] = []
  for (const runId of runIds) {
    let summary: LabRunSummary | null = null
    try {
      summary = await readRunSummaryFresh(projectRoot, sandbox.id, runId)
    } catch {
      summary = null
    }
    if (!summary) {
      findings.push({ entityId: runId, entityKind: "run", reason: `the run summary for ${runId} is missing or unreadable on disk`, detectedAt: now })
      findings.push({ entityId: runId, entityKind: "evidence", reason: `the evidence file for run ${runId} is missing or unreadable on disk`, detectedAt: now })
      continue
    }
    summaries.push(summary)
    if (typeof summary.commit === "string" && summary.commit !== currentHead) {
      findings.push({
        entityId: runId,
        entityKind: "run",
        reason: `the repository head moved from ${summary.commit.slice(0, 12)} to ${currentHead.slice(0, 12)} after the run`,
        detectedAt: now,
      })
    }
  }

  if (sandbox.lastPatchId && sandbox.promotedPatchHash) {
    if (!sandbox.lastDiffPath) {
      findings.push({ entityId: sandbox.lastPatchId, entityKind: "patch", reason: "the promoted patch path disappeared from the sandbox record", detectedAt: now })
    } else {
      try {
        const text = await fs.readFile(sandbox.lastDiffPath, "utf-8")
        if (sha256(text) !== sandbox.promotedPatchHash) {
          findings.push({ entityId: sandbox.lastPatchId, entityKind: "patch", reason: "the reviewed patch file was edited after promotion", detectedAt: now })
        }
      } catch {
        findings.push({ entityId: sandbox.lastPatchId, entityKind: "patch", reason: "the reviewed patch file is missing after promotion", detectedAt: now })
      }
    }
  }

  const baselines = await collectBaselines(projectRoot)
  for (const baseline of baselines) {
    if (baseline.sandboxId !== sandbox.id) continue
    const newerRuns = summaries.filter((summary) => summary.startedAt > baseline.createdAt).length
    if (newerRuns >= STALE_BASELINE_RUNS) {
      findings.push({
        entityId: baseline.runId,
        entityKind: "baseline",
        reason: `the baseline from run ${baseline.runId} predates ${newerRuns} newer runs, which is ${STALE_BASELINE_RUNS} or more`,
        detectedAt: now,
      })
    }
  }

  const sessions = (await readSessions(projectRoot)).sessions.filter(
    (entry) => entry.sandboxId === sandbox.id && (entry.status === "active" || entry.status === "resumed"),
  )
  if (sessions.length > 0) {
    const patch = await collectPatch(sandbox.sandboxRoot)
    const patchHash = sha256(patch.patch)
    const currentSandboxHead = await headCommit(sandbox.sandboxRoot)
    for (const session of sessions) {
      const checkpoint = await latestCheckpoint(projectRoot, session.id)
      if (!checkpoint) continue
      if (checkpoint.sandboxHead !== currentSandboxHead || checkpoint.patchHash !== patchHash) {
        findings.push({
          entityId: `${session.id}/${checkpoint.index}`,
          entityKind: "checkpoint",
          reason: `checkpoint ${checkpoint.index} no longer matches the sandbox state, so the session drifted after it was taken`,
          detectedAt: now,
        })
      }
    }
  }

  for (const finding of findings) {
    validateFinding(finding, sandbox.id)
  }
  return findings
}

export interface LabStalenessReport {
  current: LabStaleFinding[]
  fresh: LabStaleFinding[]
}

// Journals every new finding with its reason and timestamp, keeping old records so nothing is ever erased.
// The report returns the live findings for display plus the ones this call journaled for the first time.
// Journals every new finding with its reason and timestamp, keeping old records so nothing is ever erased.
async function journalFindings(
  projectRoot: string,
  sandbox: LabSandbox,
  current: LabStaleFinding[],
): Promise<LabStalenessReport["fresh"]> {
  if (current.length === 0) return []
  await ensureLabHome(projectRoot)
  return withLabLock(stalenessLock(projectRoot, sandbox.id), async () => {
    const known = new Set((await readStaleJournal(projectRoot, sandbox.id)).map((record) => `${record.entityId}\u0000${record.entityKind}\u0000${record.reason}`))
    const fresh: LabStaleFinding[] = []
    for (const finding of current) {
      if (known.has(`${finding.entityId}\u0000${finding.entityKind}\u0000${finding.reason}`)) continue
      const when = new Date().toISOString()
      await appendAuditLine(stalenessFile(projectRoot, sandbox.id), `${JSON.stringify({ kind: "stale", when, entityId: finding.entityId, entityKind: finding.entityKind, reason: finding.reason })}\n`)
      await appendLabAudit({
        kind: "lab_stale",
        projectRoot,
        when,
        sandboxId: sandbox.id,
        isolationProvider: sandbox.provider,
        details: {
          entityId: finding.entityId,
          entityKind: finding.entityKind,
          reason: finding.reason,
        },
      })
      fresh.push({ ...finding, detectedAt: when })
    }
    return fresh
  })
}

// The heavy staleness pass: reads run summaries, patch files, baselines and checkpoints.
export async function markStaleEvidence(projectRoot: string, sandbox: LabSandbox): Promise<LabStalenessReport> {
  const current = await detectStaleEvidence(projectRoot, sandbox)
  const fresh = await journalFindings(projectRoot, sandbox, current)
  return { current, fresh }
}

// Light staleness check for `status`, reading only the run index and the HEAD, never run summaries or diff payloads.
export async function detectStaleEvidenceLight(projectRoot: string, sandbox: LabSandbox): Promise<LabStaleFinding[]> {
  if (sandbox.status === "destroyed") return []
  try {
    await fs.lstat(sandbox.sandboxRoot)
  } catch {
    return []
  }
  const currentHead = await headCommit(sandbox.repoRoot)
  const entries = await readRunIndex(projectRoot, sandbox.id)
  const now = new Date().toISOString()
  const findings: LabStaleFinding[] = entries
    .filter((entry) => entry.commit !== "" && entry.commit !== currentHead)
    .map((entry) => ({
      entityId: entry.runId,
      entityKind: "run" as LabStaleEntityKind,
      reason: `the repository head moved from ${entry.commit.slice(0, 12)} to ${currentHead.slice(0, 12)} after the run`,
      detectedAt: now,
    }))
  for (const finding of findings) {
    validateFinding(finding, sandbox.id)
  }
  return findings
}

export async function markStaleEvidenceLight(projectRoot: string, sandbox: LabSandbox): Promise<LabStalenessReport> {
  const current = await detectStaleEvidenceLight(projectRoot, sandbox)
  const fresh = await journalFindings(projectRoot, sandbox, current)
  return { current, fresh }
}

// Prints the findings as a review ready section, so status and compare name every stale artifact.
export function formatStaleFindings(findings: LabStaleFinding[]): string {
  const lines = ["Stale evidence:"]
  for (const finding of findings) {
    lines.push(`  ${finding.entityKind} ${finding.entityId} is stale because ${finding.reason}`)
  }
  return lines.join("\n")
}

async function collectBaselines(projectRoot: string): Promise<Array<{ sandboxId: string, runId: string, createdAt: string }>> {
  const baselines: Array<{ sandboxId: string, runId: string, createdAt: string }> = []
  let adapters: string[] = []
  try {
    adapters = await fs.readdir(labPaths(projectRoot).baselines)
  } catch {
    return baselines
  }
  for (const adapter of adapters) {
    let files: string[] = []
    try {
      files = (await fs.readdir(path.join(labPaths(projectRoot).baselines, adapter))).filter((entry) => entry.endsWith(".json"))
    } catch {
      continue
    }
    for (const file of files) {
      let parsed: { sandboxId?: string, runId?: string, createdAt?: string } | null
      try {
        parsed = JSON.parse(await fs.readFile(path.join(labPaths(projectRoot).baselines, adapter, file), "utf-8"))
      } catch {
        parsed = null
      }
      if (parsed && typeof parsed.sandboxId === "string" && typeof parsed.runId === "string" && typeof parsed.createdAt === "string") {
        baselines.push({ sandboxId: parsed.sandboxId, runId: parsed.runId, createdAt: parsed.createdAt })
      }
    }
  }
  return baselines
}
