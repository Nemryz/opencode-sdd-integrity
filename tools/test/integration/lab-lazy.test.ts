import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"
import { createSandbox } from "../../lab/core/sandbox"
import { readRegistry, readRunIndex, readRunSummary, runIndexFile, writeRunSummary } from "../../lab/core/registry"
import { runLab } from "../../lab/core/run"
import { createSession } from "../../lab/core/session"
import { clearCache, getCached } from "../../lab/core/cache"
import { detectStaleEvidenceLight } from "../../lab/core/staleness"
import { createBaseline, writeBaseline } from "../../lab/core/baseline"
import speckitLab from "../../speckit-lab"
import type { LabAdapter, LabSandbox } from "../../lab/core/types"
import { removeWorktree } from "../../lab/core/git"

let repo: string
let sandbox: LabSandbox

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

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

beforeEach(async () => {
  repo = await createTempWorktree()
  git(["init", "-q"])
  git(["config", "user.email", "lab@example.com"])
  git(["config", "user.name", "Lab Tester"])
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "lab-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2), "utf-8")
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

// Spies on fs.readFile and returns a reads function (the paths it was called with) plus the restore function.
function spyReadFile(): { reads: () => string[], restore: () => void } {
  const spy = vi.spyOn(fs, "readFile")
  return {
    reads: () => spy.mock.calls.map((call) => String(call[0])),
    restore: () => spy.mockRestore(),
  }
}

async function runProbe() {
  return runLab({
    projectRoot: repo,
    sandbox,
    adapter: probeAdapter,
    selection: { category: "probe" },
  })
}

describe("lab lazy reads", () => {
  it("status lists the latest run from the index and reads no summary payloads", async () => {
    const summary = await runProbe()

    clearCache()
    const spy = spyReadFile()
    const result = await speckitLab.execute({ subcommand: "status", id: sandbox.id }, mockContext(repo))
    const reads = spy.reads()
    spy.restore()

    expect(result.output).toContain("Latest run:")
    expect(result.output).toContain(summary.runId)
    expect(result.output).toContain(summary.status.toUpperCase())
    expect(reads.some((path) => path.endsWith("summary.json"))).toBe(false)
    expect(reads.some((path) => path.endsWith("flakes.json") || /step-\d+\.log$/.test(path))).toBe(false)
    expect(reads.some((path) => path.endsWith("index.json"))).toBe(true)
    expect(result.metadata).toMatchObject({ latestRunId: summary.runId })
  })

  it("compare still reads the full run summary", async () => {
    const summary = await runProbe()
    await writeBaseline(repo, createBaseline(summary, git(["rev-parse", "HEAD"])))

    clearCache()
    const spy = spyReadFile()
    const result = await speckitLab.execute({ subcommand: "compare", id: sandbox.id }, mockContext(repo))
    const reads = spy.reads()
    spy.restore()

    expect(result.title).toContain("Compare")
    expect(reads.some((path) => path.endsWith("summary.json"))).toBe(true)
  })

  it("status works with no runs recorded", async () => {
    const result = await speckitLab.execute({ subcommand: "status", id: sandbox.id }, mockContext(repo))
    expect(result.output).toContain("No run has been recorded yet.")
    expect(result.metadata).toMatchObject({ latestRunId: undefined })
  })

  it("keeps a process-local cache for run summaries", async () => {
    const summary = await runProbe()

    const first = await readRunSummary(repo, sandbox.id, summary.runId)
    const second = await readRunSummary(repo, sandbox.id, summary.runId)
    expect(first).not.toBeNull()
    expect(second).toBe(first)

    clearCache()
    const third = await readRunSummary(repo, sandbox.id, summary.runId)
    expect(third).toEqual(first)

    summary.notes.push("marker")
    await writeRunSummary(repo, summary)
    const fourth = await readRunSummary(repo, sandbox.id, summary.runId)
    expect(fourth?.notes).toContain("marker")
  })

  it("caches the run index and updates it on write", async () => {
    const summary = await runProbe()
    clearCache()
    const first = await readRunIndex(repo, sandbox.id)
    expect(first.map((entry) => entry.runId)).toContain(summary.runId)
    expect(getCached(`run-index|${repo}|${sandbox.id}|`)).toEqual(first)

    summary.notes.push("index-marker")
    await writeRunSummary(repo, summary)
    const second = await readRunIndex(repo, sandbox.id)
    expect(second.map((entry) => entry.runId)).toContain(summary.runId)
  })

  it("rebuilds the index from run directories when the index file is missing", async () => {
    const summary = await runProbe()
    await fs.rm(runIndexFile(repo, sandbox.id), { force: true })
    const entries = await readRunIndex(repo, sandbox.id)
    expect(entries.map((entry) => entry.runId)).toContain(summary.runId)
  })

  it("light staleness flags a moved HEAD without reading run summaries", async () => {
    await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await runProbe()

    await fs.writeFile(path.join(repo, "README.md"), "moved\n", "utf-8")
    git(["add", "-A"])
    git(["commit", "-m", "move head"])

    const spy = spyReadFile()
    const findings = await detectStaleEvidenceLight(repo, sandbox)
    const reads = spy.reads()
    spy.restore()

    expect(findings.map((finding) => finding.entityKind)).toContain("run")
    expect(reads.some((path) => path.endsWith("summary.json"))).toBe(false)
  })
})
