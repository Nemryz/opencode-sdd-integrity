import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, repoRootDir } from "../helpers/setup"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import { promoteDiff, reviewDiff } from "../../lab/core/diff"
import { runLab } from "../../lab/core/run"
import { createSession } from "../../lab/core/session"
import {
  formatEvidenceGraph,
  graphByEvidence,
  graphByPatch,
  graphByRun,
  graphBySession,
  graphDependsOn,
  graphEdgesTouching,
  graphSupports,
  loadEvidenceGraph,
} from "../../lab/core/evidence"
import { provenanceFile } from "../../lab/core/provenance"
import { readRegistry } from "../../lab/core/registry"
import { removeWorktree } from "../../lab/core/git"
import type { LabAdapter, LabSandbox } from "../../lab/core/types"
import type { LabEvidenceGraph } from "../../lab/core/evidence"

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

describe("lab evidence graph", () => {
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

  async function buildFullChain(): Promise<{ session: Awaited<ReturnType<typeof createSession>>, patchId: string }> {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
      taskId: "task-20261111000000-abcdefab",
    })
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "graph\n", "utf-8")
    const reviewed = await reviewDiff(repo, sandbox)
    await promoteDiff(repo, await loadSandbox(repo, sandbox.id))
    return { session, patchId: reviewed.patchId }
  }

  it("rebuilds the whole chain from disk with typed nodes", async () => {
    const { session, patchId } = await buildFullChain()

    const graph = await loadEvidenceGraph(repo)
    const kinds = Object.fromEntries(graph.nodes.map((node) => [node.kind, node.id]))
    expect(kinds.session).toBe(session.id)
    expect(kinds.sandbox).toBe(sandbox.id)
    expect(kinds.task).toBe("task-20261111000000-abcdefab")
    expect(kinds.evidence).toMatch(/^evidence-/)
    expect(kinds.patch).toBe(patchId)
    expect(kinds.promotion).toMatch(/^promotion-/)
    expect(graph.nodes.find((node) => node.id.startsWith("run") || node.kind === "run")).toBeDefined()

    const promoted = graph.edges.find((edge) => edge.relation === "promoted")
    expect(promoted).toMatchObject({ from: kinds.promotion, to: patchId, sessionId: session.id })
    expect(promoted?.when).toBeTruthy()
  })

  it("answers supports dependsOn and scoped queries", async () => {
    const { session, patchId } = await buildFullChain()
    const graph = await loadEvidenceGraph(repo)
    const runNode = graph.nodes.find((node) => node.kind === "run")
    const evidenceNode = graph.nodes.find((node) => node.kind === "evidence")
    const promotionNode = graph.nodes.find((node) => node.kind === "promotion")
    if (!runNode || !evidenceNode || !promotionNode) throw new Error("graph fixture lost a node")

    expect(graphSupports(graph, runNode.id)).toHaveLength(1)
    expect(graphSupports(graph, runNode.id)[0]).toMatchObject({ from: evidenceNode.id, relation: "tested" })
    expect(graphSupports(graph, patchId)).toHaveLength(1)
    expect(graphSupports(graph, patchId)[0]).toMatchObject({ from: promotionNode.id, relation: "promoted" })
    expect(graphSupports(graph, session.id)).toEqual([])

    const produced = graphDependsOn(graph, session.id)
    expect(produced).toHaveLength(2)
    expect(produced.map((edge) => edge.relation)).toEqual(["produced", "produced"])
    expect(graphDependsOn(graph, evidenceNode.id)).toEqual([
      { from: evidenceNode.id, relation: "tested", sessionId: session.id, to: runNode.id, when: expect.any(String) },
    ])
    expect(graphDependsOn(graph, evidenceNode.id)).toEqual(graph.edges.filter((edge) => edge.from === evidenceNode.id))

    expect(graphEdgesTouching(graph, patchId)).toEqual(graphByPatch(graph, patchId))
    expect(graphByRun(graph, runNode.id)).toHaveLength(3)
    expect(graphByEvidence(graph, evidenceNode.id)).toEqual(graphEdgesTouching(graph, evidenceNode.id))
    expect(graphBySession(graph, session.id)).toHaveLength(graph.edges.length)
    expect(graph.edges.every((edge) => edge.sessionId === session.id)).toBe(true)
  })

  it("scopes a build to one session and keeps other sessions out", async () => {
    const sessionA = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const other = await createSandbox({ projectRoot: repo, adapter: "integrity" })
    const sessionB = await createSession({ projectRoot: repo, sandboxId: other.id })

    const scoped = await loadEvidenceGraph(repo, { sessionId: sessionA.id })
    expect(scoped.edges).toHaveLength(1)
    expect(scoped.edges[0]).toMatchObject({ from: sessionA.id, to: sandbox.id, sessionId: sessionA.id })

    const full = await loadEvidenceGraph(repo)
    expect(full.edges).toHaveLength(2)
    expect(full.edges.map((edge) => edge.sessionId)).toEqual([sessionA.id, sessionB.id])
    expect(full.nodes.find((node) => node.id === other.id)?.kind).toBe("sandbox")
    expect(full.nodes.find((node) => node.id === sessionB.id)?.kind).toBe("session")

    await destroySandbox(repo, other, true)
  })

  it("fails loud on a dangling bare id but trusts typed prefixes", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const file = provenanceFile(repo, session.id)
    await fs.chmod(file, 0o600)
    await fs.appendFile(
      file,
      `${JSON.stringify({ kind: "linked", when: "w", from: session.id, to: "20261111000000-deadbeef", relation: "produced" })}\n`,
      "utf-8",
    )
    await fs.chmod(file, 0o400)
    await expect(loadEvidenceGraph(repo)).rejects.toThrow(/dangling reference 20261111000000-deadbeef/)

    await fs.chmod(file, 0o600)
    const text = await fs.readFile(file, "utf-8")
    const kept = text.split("\n").filter((line) => line.trim() !== "" && !line.includes("deadbeef"))
    await fs.writeFile(
      file,
      `${kept.join("\n")}\n${JSON.stringify({ kind: "linked", when: "w", from: "task-20261111000000-fedcba98", to: session.id, relation: "tested" })}\n`,
      "utf-8",
    )
    await fs.chmod(file, 0o400)
    const graph = await loadEvidenceGraph(repo)
    expect(graph.nodes.find((node) => node.id === "task-20261111000000-fedcba98")?.kind).toBe("task")
  })

  it("rebuilds deterministically so every read derives the same graph", async () => {
    await buildFullChain()
    const first = await loadEvidenceGraph(repo)
    const second = await loadEvidenceGraph(repo)
    expect(second).toEqual(first as LabEvidenceGraph)
    expect(formatEvidenceGraph(first).split("\n")[0]).toContain("nodes and")
    expect(formatEvidenceGraph(first).split("\n")).toHaveLength(first.nodes.length + first.edges.length + 1)
  })
})
