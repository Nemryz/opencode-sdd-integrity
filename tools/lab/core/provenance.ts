import fs from "node:fs/promises"
import path from "node:path"
import type { LabProvenanceRecord, LabProvenanceRelation } from "./types"
import { isLabProvenanceRelation } from "./types"
import { isLabEntityId } from "./identity"
import { ensureLabHome, labPaths } from "./home"
import { appendAuditLine, appendLabAudit } from "./audit"

export function provenanceDir(projectRoot: string): string {
  return labPaths(projectRoot).provenance
}

export function provenanceFile(projectRoot: string, sessionId: string): string {
  if (!isLabEntityId(sessionId)) {
    throw new Error(`Lab provenance needs a safe session id, received ${JSON.stringify(sessionId)}`)
  }
  return path.join(provenanceDir(projectRoot), `${sessionId}.jsonl`)
}

// Links two entities inside the session sidecar and mirrors the edge into the project audit trail.
export async function linkProvenance(
  projectRoot: string,
  sessionId: string,
  from: string,
  to: string,
  relation: LabProvenanceRelation,
): Promise<void> {
  if (!isLabEntityId(from) || !isLabEntityId(to)) {
    throw new Error(`Lab provenance needs safe entity ids, received from ${JSON.stringify(from)} to ${JSON.stringify(to)}`)
  }
  if (!isLabProvenanceRelation(relation)) {
    throw new Error(`Lab provenance relation ${JSON.stringify(relation)} is not one of produced tested promoted invalidated`)
  }
  await ensureLabHome(projectRoot)
  const when = new Date().toISOString()
  await appendAuditLine(provenanceFile(projectRoot, sessionId), `${JSON.stringify({ kind: "linked", when, from, to, relation })}\n`)
  await appendLabAudit({
    kind: "lab_provenance",
    projectRoot,
    when,
    details: {
      sessionId,
      from,
      to,
      relation,
    },
  })
}

// Reads the provenance edges in file order and fails loud on the first malformed line.
export async function readProvenance(projectRoot: string, sessionId: string): Promise<LabProvenanceRecord[]> {
  let text: string
  try {
    text = await fs.readFile(provenanceFile(projectRoot, sessionId), "utf-8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const records: LabProvenanceRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const parsed = JSON.parse(line) as Partial<LabProvenanceRecord>
    if (!parsed || parsed.kind !== "linked") {
      throw new Error(`Lab provenance line for session ${sessionId} is not a linked record`)
    }
    if (!isLabEntityId(parsed.from) || !isLabEntityId(parsed.to) || !isLabProvenanceRelation(parsed.relation)) {
      throw new Error(`Lab provenance line for session ${sessionId} carries an unsafe edge`)
    }
    if (typeof parsed.when !== "string" || parsed.when.trim() === "") {
      throw new Error(`Lab provenance line for session ${sessionId} is missing its timestamp`)
    }
    records.push({ kind: "linked", when: parsed.when, from: parsed.from, to: parsed.to, relation: parsed.relation })
  }
  return records
}
