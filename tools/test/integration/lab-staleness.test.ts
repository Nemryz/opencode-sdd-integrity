import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"
import { createSandbox, loadSandbox } from "../../lab/core/sandbox"
import { promoteDiff, reviewDiff } from "../../lab/core/diff"
import { runLab } from "../../lab/core/run"
import { createCheckpoint, createSession, resumeSession } from "../../lab/core/session"
import { createBaseline, writeBaseline, readBaseline } from "../../lab/core/baseline"
import {
  STALE_BASELINE_RUNS,
  detectStaleEvidence,
  formatStaleFindings,
  markStaleEvidence,
  readStaleJournal,
  stalenessFile,
} from "../../lab/core/staleness"
import { readLabAudit } from "../../lab/core/audit"
import { readRegistry } from "../../lab/core/registry"
import { removeWorktree } from "../../lab/core/git"
import speckitLab from "../../speckit-lab"
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

describe("lab staleness detection", () => {
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

  async function oneRun() {
    return runLab({
      projectRoot: repo,
      sandbox,
      adapter: probeAdapter,
      selection: { category: "probe" },
    })
  }

  it("flags a run once the repository head moves past it and journals it exactly once", async () => {
    await oneRun()
    let findings = await detectStaleEvidence(repo, sandbox)
    expect(findings).toEqual([])

    await fs.writeFile(path.join(repo, "README.md"), "moved\n", "utf-8")
    git(["add", "-A"])
    git(["commit", "-m", "advance head"])

    findings = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(findings).toHaveLength(1)
    expect(findings[0].entityKind).toBe("run")
    expect(findings[0].reason).toContain("moved")

    const first = await markStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(first.fresh).toHaveLength(1)
    const again = await markStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(again.fresh).toEqual([])
    expect(again.current).toHaveLength(1)

    const journal = await readStaleJournal(repo, sandbox.id)
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ kind: "stale", entityKind: "run" })
    expect(journal[0].reason).toContain("moved")

    const audit = await readLabAudit(repo)
    const staleEvents = audit.filter((entry) => entry.kind === "lab_stale")
    expect(staleEvents).toHaveLength(1)
    expect(staleEvents[0].details?.entityKind).toBe("run")

    const mode = (await fs.stat(stalenessFile(repo, sandbox.id))).mode & 0o777
    expect(mode).toBe(process.platform === "win32" ? 0o444 : 0o400)
  })

  it("flags the reviewed patch when its file is edited or lost after promotion", async () => {
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "patched\n", "utf-8")
    const reviewed = await reviewDiff(repo, sandbox)
    await promoteDiff(repo, await loadSandbox(repo, sandbox.id))
    expect(await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))).toEqual([])

    await fs.writeFile(reviewed.patchPath, "tampered\n", "utf-8")
    const edited = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(edited).toHaveLength(1)
    expect(edited[0]).toMatchObject({ entityId: reviewed.patchId, entityKind: "patch" })
    expect(edited[0].reason).toContain("edited after promotion")

    await fs.rm(reviewed.patchPath, { force: true })
    const lost = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(lost[0].reason).toContain("missing after promotion")
  })

  it("flags a baseline that predates too many newer runs", async () => {
    const first = await oneRun()
    const head = git(["rev-parse", "HEAD"])
    const file = await writeBaseline(repo, createBaseline(first, head))
    const raw = JSON.parse(await fs.readFile(file, "utf-8"))
    raw.createdAt = "2020-01-01T00:00:00.000Z"
    await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf-8")
    expect(await readBaseline(repo, first.adapter, first.selection)).toMatchObject({ createdAt: "2020-01-01T00:00:00.000Z" })

    for (let index = 0; index < STALE_BASELINE_RUNS; index++) {
      await oneRun()
    }

    const findings = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    const baselineFindings = findings.filter((finding) => finding.entityKind === "baseline")
    expect(baselineFindings).toHaveLength(1)
    expect(baselineFindings[0].entityId).toBe(first.runId)
    expect(baselineFindings[0].reason).toContain(`${STALE_BASELINE_RUNS} or more`)
  })

  it("flags checkpoint drift for an active session without touching other sandboxes", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, session.id)
    expect(await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))).toEqual([])

    await fs.writeFile(path.join(sandbox.sandboxRoot, "drift.md"), "drift\n", "utf-8")
    const findings = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(findings).toHaveLength(1)
    expect(findings[0].entityKind).toBe("checkpoint")
    expect(findings[0].entityId).toBe(`${session.id}/1`)

    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(/resume refused/)
  })

  it("flags runs and evidence whose summary files vanish", async () => {
    const summary = await oneRun()
    expect(await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))).toEqual([])

    await fs.rm(summary.summaryPath, { force: true })
    const findings = await detectStaleEvidence(repo, await loadSandbox(repo, sandbox.id))
    expect(findings.map((finding) => finding.entityKind)).toEqual(["run", "evidence"])
    expect(findings.every((finding) => finding.entityId === summary.runId)).toBe(true)
  })

  it("refuses a resume when the checkpointed evidence file is gone", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const summary = await oneRun()
    await createCheckpoint(repo, session.id, { runId: summary.runId, runSummaryPath: summary.summaryPath })
    await fs.rm(summary.summaryPath, { force: true })

    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(
      /cannot resume because the evidence file for run .* is missing/,
    )
  })

  it("surfaces stale evidence through status and compare", async () => {
    const first = await oneRun()
    await fs.writeFile(path.join(repo, "README.md"), "moved\n", "utf-8")
    git(["add", "-A"])
    git(["commit", "-m", "advance head for compare"])

    const status = await speckitLab.execute({ subcommand: "status", id: sandbox.id }, mockContext(repo))
    expect(status.output).toContain("Stale evidence")
    expect((status.metadata as Record<string, unknown>).staleCount).toBe(1)

    const baseline = await writeBaseline(repo, createBaseline(first, git(["rev-parse", "HEAD"])))
    expect(baseline).toBeTruthy()
    const comparison = await speckitLab.execute({ subcommand: "compare", id: sandbox.id }, mockContext(repo))
    expect(comparison.output).toContain("Stale evidence")
    expect((comparison.metadata as Record<string, unknown>).staleCount).toBe(1)

    const formatted = formatStaleFindings([{ entityId: "x", entityKind: "run", reason: "r", detectedAt: "t" }])
    expect(formatted.split("\n")[0]).toBe("Stale evidence:")
    expect(formatted.split("\n")[1]).toContain("run x is stale because r")
  })
})
