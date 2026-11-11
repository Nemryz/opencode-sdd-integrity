import fs from "node:fs/promises"
import path from "node:path"
import type { LabProvenanceRelation } from "./types"
import { isLabEntityId } from "./identity"
import { labPaths } from "./home"
import { readSessions } from "./session"
import { readRegistry } from "./registry"
import { readProvenance } from "./provenance"

export type LabEvidenceNodeKind = "session" | "run" | "task" | "patch" | "evidence" | "promotion" | "sandbox"

export interface LabEvidenceNode {
  id: string
  kind: LabEvidenceNodeKind
}

export interface LabEvidenceEdge {
  from: string
  to: string
  relation: LabProvenanceRelation
  sessionId: string
  when: string
}

export interface LabEvidenceGraph {
  nodes: LabEvidenceNode[]
  edges: LabEvidenceEdge[]
}

const PREFIX_KINDS: Array<[string, LabEvidenceNodeKind]> = [
  ["task-", "task"],
  ["patch-", "patch"],
  ["evidence-", "evidence"],
  ["promotion-", "promotion"],
]

// Walks every run directory name, so run ids resolve without reading any payload.
async function collectRunIds(projectRoot: string): Promise<Set<string>> {
  const runs = new Set<string>()
  let sandboxes: string[] = []
  try {
    sandboxes = await fs.readdir(labPaths(projectRoot).reports)
  } catch {
    return runs
  }
  for (const sandboxId of sandboxes) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(path.join(labPaths(projectRoot).reports, sandboxId, "runs"))
    } catch {
      continue
    }
    for (const runId of entries) {
      if (isLabEntityId(runId)) runs.add(runId)
    }
  }
  return runs
}

// Resolves one id against the registries and the run layout, so a bare id that points at nothing fails loud.
function resolveNodeKind(
  id: string,
  known: { sessions: Set<string>, sandboxes: Set<string>, runs: Set<string> },
  sessionId: string,
): LabEvidenceNodeKind {
  for (const [prefix, kind] of PREFIX_KINDS) {
    if (id.startsWith(prefix)) return kind
  }
  if (known.sessions.has(id)) return "session"
  if (known.sandboxes.has(id)) return "sandbox"
  if (known.runs.has(id)) return "run"
  throw new Error(`Lab evidence graph found a dangling reference ${id} inside the sidecar of session ${sessionId}`)
}

// Rebuilds the evidence graph from the append only sidecars, so every read is derived and never stored twice.
export async function loadEvidenceGraph(projectRoot: string, options: { sessionId?: string } = {}): Promise<LabEvidenceGraph> {
  const registry = await readSessions(projectRoot)
  const sessions = options.sessionId
    ? registry.sessions.filter((entry) => entry.id === options.sessionId)
    : registry.sessions
  const known = {
    sessions: new Set(registry.sessions.map((entry) => entry.id)),
    sandboxes: new Set((await readRegistry(projectRoot)).sandboxes.map((entry) => entry.id)),
    runs: await collectRunIds(projectRoot),
  }
  const edges: LabEvidenceEdge[] = []
  for (const session of sessions) {
    const records = await readProvenance(projectRoot, session.id)
    for (const record of records) {
      edges.push({
        from: record.from,
        to: record.to,
        relation: record.relation,
        sessionId: session.id,
        when: record.when,
      })
    }
  }
  const nodeIds = new Map<string, LabEvidenceNodeKind>()
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (!nodeIds.has(id)) {
        nodeIds.set(id, resolveNodeKind(id, known, edge.sessionId))
      }
    }
  }
  const nodes = [...nodeIds.entries()].map(([id, kind]) => ({ id, kind }))
  return { nodes, edges }
}

// Returns every edge that touches an entity, regardless of direction or relation.
export function graphEdgesTouching(graph: LabEvidenceGraph, id: string): LabEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.from === id || edge.to === id)
}

// Returns the incoming edges that carry support for an entity, so a claim names the artifacts backing it.
export function graphSupports(graph: LabEvidenceGraph, id: string): LabEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.to === id && (edge.relation === "tested" || edge.relation === "promoted"))
}

// Returns the outgoing edges of an entity, so a patch or a session names what it produced or depends on.
export function graphDependsOn(graph: LabEvidenceGraph, id: string): LabEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.from === id)
}

// Filters the graph down to the edges of one session, which keeps multi session reports scoped.
export function graphBySession(graph: LabEvidenceGraph, sessionId: string): LabEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.sessionId === sessionId)
}

export function graphByRun(graph: LabEvidenceGraph, runId: string): LabEvidenceEdge[] {
  return graphEdgesTouching(graph, runId)
}

export function graphByPatch(graph: LabEvidenceGraph, patchId: string): LabEvidenceEdge[] {
  return graphEdgesTouching(graph, patchId)
}

export function graphByEvidence(graph: LabEvidenceGraph, evidenceId: string): LabEvidenceEdge[] {
  return graphEdgesTouching(graph, evidenceId)
}

// Prints a stable readable summary, so a review sees nodes then edges in file order.
export function formatEvidenceGraph(graph: LabEvidenceGraph): string {
  const lines = [`Evidence graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`]
  for (const node of graph.nodes) {
    lines.push(`  node ${node.kind} ${node.id}`)
  }
  for (const edge of graph.edges) {
    lines.push(`  edge ${edge.from} -${edge.relation}-> ${edge.to} (session ${edge.sessionId})`)
  }
  return lines.join("\n")
}
