import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, repoRootDir } from "../helpers/setup"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import { collectDiff, promoteDiff, reviewDiff } from "../../lab/core/diff"
import { runLab } from "../../lab/core/run"
import {
  activeSessionForSandbox,
  createCheckpoint,
  createSession,
  pruneSessions,
  resumeSession,
} from "../../lab/core/session"
import { linkProvenance, provenanceFile, readProvenance } from "../../lab/core/provenance"
import { readLabAudit } from "../../lab/core/audit"
import { readRegistry } from "../../lab/core/registry"
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

describe("lab provenance sidecar", () => {
  it("opens a session with a produced edge into an immutable sidecar", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })

    const edges = await readProvenance(repo, session.id)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: session.id, to: sandbox.id, relation: "produced" })

    const audit = await readLabAudit(repo)
    const linked = audit.filter((entry) => entry.kind === "lab_provenance")
    expect(linked).toHaveLength(1)
    expect(linked[0].details?.from).toBe(session.id)
    expect(linked[0].details?.relation).toBe("produced")

    const mode = (await fs.stat(provenanceFile(repo, session.id))).mode & 0o777
    expect(mode).toBe(process.platform === "win32" ? 0o444 : 0o400)
  })

  it("refuses unsafe ids and unknown relations", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await expect(linkProvenance(repo, session.id, "../escape", sandbox.id, "produced")).rejects.toThrow(
      /needs safe entity ids/,
    )
    await expect(linkProvenance(repo, session.id, session.id, sandbox.id, "deleted" as never)).rejects.toThrow(
      /is not one of produced/,
    )
    await expect(linkProvenance(repo, "../escape", session.id, sandbox.id, "produced")).rejects.toThrow(
      /needs a safe session id/,
    )
  })

  it("fails loud on a tampered sidecar line", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const file = provenanceFile(repo, session.id)
    await fs.chmod(file, 0o600)
    await fs.writeFile(file, `${JSON.stringify({ kind: "linked", when: "t", from: "a", to: "b", relation: "nope" })}\n`, "utf-8")
    await fs.chmod(file, 0o400)
    await expect(readProvenance(repo, session.id)).rejects.toThrow(/carries an unsafe edge/)

    await fs.chmod(file, 0o600)
    await fs.writeFile(file, "not json\n", "utf-8")
    await fs.chmod(file, 0o400)
    await expect(readProvenance(repo, session.id)).rejects.toThrow()
  })
})

describe("lab provenance chain", () => {
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

  it("records run and evidence edges for every run against a sandbox with a session", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })

    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
      taskId: "task-20261110000000-abcdefab",
    })
    expect(summary.evidenceId).toMatch(/^evidence-/)
    expect(summary.taskId).toBe("task-20261110000000-abcdefab")

    const edges = await readProvenance(repo, session.id)
    expect(edges).toHaveLength(3)
    expect(edges[0]).toMatchObject({ from: session.id, to: sandbox.id, relation: "produced" })
    expect(edges[1]).toMatchObject({ from: session.id, to: summary.runId, relation: "produced" })
    expect(edges[2]).toMatchObject({ from: summary.evidenceId, to: summary.runId, relation: "tested" })
  })

  it("keeps runs of sandboxes without sessions out of the provenance files", async () => {
    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
    })
    expect(summary.evidenceId).toMatch(/^evidence-/)
    const files = await fs.readdir(path.join(repo, ".opencode", "lab", "provenance")).catch(() => [])
    expect(files).toEqual([])
    expect(await activeSessionForSandbox(repo, sandbox.id)).toBeNull()
  })

  it("records patch and promotion ids through review and promote", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "promoted\n", "utf-8")

    const reviewed = await reviewDiff(repo, sandbox)
    expect(reviewed.patchId).toMatch(/^patch-/)
    let stored = await loadSandbox(repo, sandbox.id)
    expect(stored.lastPatchId).toBe(reviewed.patchId)

    const promoted = await promoteDiff(repo, await loadSandbox(repo, sandbox.id))
    expect(promoted.patchId).toBe(reviewed.patchId)
    expect(promoted.promotionId).toMatch(/^promotion-/)
    stored = await loadSandbox(repo, sandbox.id)
    expect(stored.lastPromotionId).toBe(promoted.promotionId)
    expect(stored.lastPatchId).toBe(reviewed.patchId)

    const edges = await readProvenance(repo, session.id)
    expect(edges.find((edge) => edge.relation === "promoted")).toMatchObject({
      from: promoted.promotionId,
      to: reviewed.patchId,
    })

    const audit = await readLabAudit(repo)
    const promotedEvents = audit.filter((entry) => entry.kind === "lab_promoted")
    expect(promotedEvents).toHaveLength(1)
    expect(promotedEvents[0].details?.promotionId).toBe(promoted.promotionId)
    expect(promotedEvents[0].details?.patchId).toBe(reviewed.patchId)
  })

  it("marks the session edge invalidated when its sandbox dies", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await destroySandbox(repo, sandbox, true)

    const edges = await readProvenance(repo, session.id)
    expect(edges).toHaveLength(2)
    expect(edges[1]).toMatchObject({ from: session.id, to: sandbox.id, relation: "invalidated" })
  })

  it("survives resume and prune without losing the chain", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, session.id)
    await resumeSession(repo, { sessionId: session.id })

    let edges = await readProvenance(repo, session.id)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: session.id, to: sandbox.id, relation: "produced" })

    // Prune keeps the sidecar of a closed session, so history stays readable after cleanup.
    await destroySandbox(repo, sandbox, true)
    await pruneSessions({ projectRoot: repo, confirmed: true })
    edges = await readProvenance(repo, session.id)
    expect(edges).toHaveLength(2)
  })
})
