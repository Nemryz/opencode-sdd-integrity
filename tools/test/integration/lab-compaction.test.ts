import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import { readRegistry, readRunSummary, runDir } from "../../lab/core/registry"
import { reviewDiff, promoteDiff } from "../../lab/core/diff"
import { runLab } from "../../lab/core/run"
import { appendSessionAudit, createSession, sessionAuditFile, sessionDir } from "../../lab/core/session"
import {
  compactRunBundle,
  compactSessionBundle,
  compactionFile,
  formatCompactionReport,
} from "../../lab/core/compaction"
import { readProvenance } from "../../lab/core/provenance"
import { loadEvidenceGraph } from "../../lab/core/evidence"
import { readLabAudit } from "../../lab/core/audit"
import { removeWorktree } from "../../lab/core/git"
import type { LabAdapter, LabSandbox } from "../../lab/core/types"
let repo: string
let sandbox: LabSandbox

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

beforeEach(async () => {
  repo = await createTempWorktree()
  git(["init", "-q"])
  git(["config", "user.email", "lab@example.com"])
  git(["config", "user.name", "Lab Tester"])
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "lab-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2),
    "utf-8",
  )
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf-8")
  git(["add", "-A"])
  git(["commit", "-m", "base"])
  sandbox = await createSandbox({ projectRoot: repo, adapter: "integrity" })
})

afterEach(async () => {
  const registry = await readRegistry(repo).catch(() => null)
  for (const entry of registry?.sandboxes ?? []) {
    if (entry.status !== "destroyed") {
      await removeWorktree(entry.repoRoot, entry.sandboxRoot).catch(() => null)
    }
  }
  await destroyTempWorktree(repo)
})

const probeAdapter: LabAdapter = {
  id: "probe",
  description: "probe",
  categories: {
    probe: { description: "probe", paths: [] },
  },
  profiles: {},
  defaultExclude: [],
  plan: () => [
    { label: "probe", command: process.execPath, args: ["-e", "console.log('probe-ok')"], timeoutMs: 5000 },
  ],
}

async function compactedCount(kind: string): Promise<number> {
  return (await readLabAudit(repo)).filter((entry) => entry.kind === kind).length
}

describe("lab bundle compaction", () => {
  it("compacts the session chronology without touching checkpoints or provenance edges", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const filler = "FILLER-BY-COMPACTION-TEST-" + "x".repeat(1500)
    await appendSessionAudit({
      kind: "lab_session_created",
      projectRoot: repo,
      sessionId: session.id,
      when: new Date().toISOString(),
      sandboxId: sandbox.id,
      isolationProvider: "worktree",
      details: { note: filler },
    })

    const checkpointsBefore = (await fs.readdir(path.join(sessionDir(repo, session.id), "checkpoints"))).sort()
    const edgesBefore = await readProvenance(repo, session.id)
    const graphBefore = await loadEvidenceGraph(repo, { sessionId: session.id })

    const report = await compactSessionBundle(repo, session.id)
    expect(report.compacted).toBe(true)
    expect(report.bytesFreed).toBeGreaterThan(0)
    expect(report.files.some((file) => file.name === "audit.jsonl" && file.kind === "replaced")).toBe(true)

    const auditText = await fs.readFile(sessionAuditFile(repo, session.id), "utf-8")
    expect(auditText).not.toContain("FILLER-BY-COMPACTION-TEST")
    expect(auditText).toContain("\"kind\":\"lab_session_created\"")

    const checkpointsAfter = (await fs.readdir(path.join(sessionDir(repo, session.id), "checkpoints"))).sort()
    expect(checkpointsAfter).toEqual(checkpointsBefore)

    expect(await readProvenance(repo, session.id)).toEqual(edgesBefore)
    const graph = await loadEvidenceGraph(repo, { sessionId: session.id })
    expect(graph.edges).toEqual(graphBefore.edges)
    expect(graph.nodes).toEqual(graphBefore.nodes)
    expect(compactionFile(repo, sessionDir(repo, session.id))).toBeTruthy()
    expect(formatCompactionReport(report)).toContain("audit.jsonl")
  })

  it("journals the session compaction once and is idempotent afterwards", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await appendSessionAudit({
      kind: "lab_session_created",
      projectRoot: repo,
      sessionId: session.id,
      when: new Date().toISOString(),
      sandboxId: sandbox.id,
      isolationProvider: "worktree",
      details: { note: "FILLER-BY-" + "y".repeat(1200) },
    })
    await compactSessionBundle(repo, session.id)
    expect(await compactedCount("lab_compacted")).toBe(1)

    const again = await compactSessionBundle(repo, session.id)
    expect(again.compacted).toBe(false)
    expect(again.bytesFreed).toBe(0)
    expect(await compactedCount("lab_compacted")).toBe(1)

    const audit = await readLabAudit(repo)
    const event = audit.find((entry) => entry.kind === "lab_compacted")
    expect(event).toBeDefined()
    if (!event) throw new Error("expected a lab_compacted audit event")
    expect(event.details?.sessionId).toBe(session.id)
    expect(event.sandboxId).toBe(sandbox.id)
    expect(event.details?.compactedFiles).toContain("audit.jsonl")
    expect(event.details?.bytesFreed).toBeGreaterThan(0)
  })

  it("compacts the bulky run step logs while keeping the run summary and the graph", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
    })
    const dir = runDir(repo, sandbox.id, summary.runId)
    await fs.writeFile(path.join(dir, "step-1.log"), "Z".repeat(600), "utf-8")
    const preservedPath = path.join(dir, "summary.json")

    const report = await compactRunBundle(repo, sandbox.id, summary.runId)
    expect(report.compacted).toBe(true)
    expect(report.files.some((file) => file.name === "step-1.log" && file.kind === "replaced")).toBe(true)
    expect(report.files.find((file) => file.name === "summary.json")?.kind).toBe("preserved")

    const logText = await fs.readFile(path.join(dir, "step-1.log"), "utf-8")
    expect(logText).not.toContain("ZZZ")
    expect(logText).toContain("Lab compacted file step-1.log")

    const reloaded = await readRunSummary(repo, sandbox.id, summary.runId)
    expect(reloaded?.runId).toBe(summary.runId)
    expect(reloaded?.evidenceId).toMatch(/^evidence-/)

    const graph = await loadEvidenceGraph(repo)
    expect(graph.nodes.find((node) => node.id === summary.runId)?.kind).toBe("run")
    expect(graph.nodes.find((node) => node.id === summary.evidenceId)?.kind).toBe("evidence")
    expect(summary.evidenceId).toMatch(/^evidence-/)
    expect(formatCompactionReport(report)).toContain("summary.json")
  })

  it("is idempotent for run bundles and journals the compaction once", async () => {
    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
    })
    const dir = runDir(repo, sandbox.id, summary.runId)
    await fs.writeFile(path.join(dir, "step-1.log"), "Z".repeat(600), "utf-8")
    await compactRunBundle(repo, sandbox.id, summary.runId)
    expect(await compactedCount("lab_compacted")).toBe(1)

    const again = await compactRunBundle(repo, sandbox.id, summary.runId)
    expect(again.compacted).toBe(false)
    expect(again.bytesFreed).toBe(0)
    expect(await compactedCount("lab_compacted")).toBe(1)
  })

  it("keeps the full chain resolvable after compacting session and run bundles", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
    })
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "compaction\n", "utf-8")
    const reviewed = await reviewDiff(repo, sandbox)
    await promoteDiff(repo, await loadSandbox(repo, sandbox.id))

    const sessionReport = await compactSessionBundle(repo, session.id)
    const runReport = await compactRunBundle(repo, sandbox.id, summary.runId)
    expect(sessionReport.compacted).toBe(true)
    expect(runReport.compacted).toBe(true)

    const graph = await loadEvidenceGraph(repo, { sessionId: session.id })
    const kinds = Object.fromEntries(graph.nodes.map((node) => [node.id, node.kind]))
    expect(kinds[session.id]).toBe("session")
    expect(kinds[sandbox.id]).toBe("sandbox")
    expect(kinds[summary.runId]).toBe("run")
    if (summary.evidenceId) expect(kinds[summary.evidenceId]).toBe("evidence")
    expect(kinds[reviewed.patchId]).toBe("patch")
    const promoted = graph.edges.find((edge) => edge.relation === "promoted")
    expect(promoted).toBeDefined()
    expect(graph.edges.filter((edge) => edge.relation === "promoted").map((edge) => edge.to)).toContain(reviewed.patchId)
  })
})
