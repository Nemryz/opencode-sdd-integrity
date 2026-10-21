import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import archiveTool from "../../speckit-archive"
import { createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"
import { writeProjectFile } from "../helpers/assertions"
import { createSnapshot } from "../../shared/snapshot/manifest"
import { drillSnapshot } from "../../shared/snapshot/retention"

// Budgets are generous on purpose: they catch catastrophic regressions (an O(n^2)
// loop, a stray sleep, a sandbox that never cleans up) without flaking on a slow CI runner.
const SNAPSHOT_CREATE_BUDGET_MS = 2000
const SNAPSHOT_DRILL_BUDGET_MS = 2000
const ARCHIVE_BUDGET_MS = 2000

let worktree: string

beforeEach(async () => {
  worktree = await createTempWorktree()
  await writeProjectFile(worktree, ".opencode/spec-memory/constitution.md", "# Constitution\n" + "x".repeat(2000))
  await writeProjectFile(worktree, ".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  for (let i = 0; i < 20; i++) {
    await writeProjectFile(worktree, `specs/${String(i).padStart(3, "0")}-demo/spec.md`, "# Spec\n" + "y".repeat(1000))
  }
  await writeProjectFile(worktree, ".opencode/steering/product.md", "# Product\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("performance: snapshot creation stays within budget", () => {
  it("creates a verified snapshot of a medium worktree under the budget", async () => {
    const start = performance.now()
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const elapsed = performance.now() - start

    expect(manifest.files.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(SNAPSHOT_CREATE_BUDGET_MS)
  })
})

describe("performance: snapshot drill stays within budget", () => {
  it("drills a medium snapshot and cleans its sandbox under the budget", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })

    const start = performance.now()
    const drill = await drillSnapshot(worktree, manifest.id)
    const elapsed = performance.now() - start

    expect(drill.ok).toBe(true)
    expect(elapsed).toBeLessThan(SNAPSHOT_DRILL_BUDGET_MS)
  })
})

describe("performance: archive stays within budget", () => {
  it("archives a complete feature under the budget", async () => {
    const featureDir = "000-demo"
    await fs.mkdir(path.join(worktree, "specs", featureDir), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", featureDir, "spec.md"), "# Spec\n", "utf-8")
    await fs.writeFile(path.join(worktree, "specs", featureDir, "spec.json"), JSON.stringify({
      feature_name: "demo",
      feature_number: 0,
      phase: "complete",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      approvals: { spec: { generated: true, approved: true }, plan: { generated: true, approved: true }, tasks: { generated: true, approved: true } },
      ready_for_implementation: true,
      active_delta: null,
      converged: true,
    }), "utf-8")

    const ctx = mockContext(worktree)
    const start = performance.now()
    const result = await archiveTool.execute({ featureDir, confirmed: true } as never, ctx)
    const elapsed = performance.now() - start

    expect(result.title).toBe("Archived")
    expect(elapsed).toBeLessThan(ARCHIVE_BUDGET_MS)
  })
})

describe("performance: snapshot drill leaves no sandbox behind", () => {
  it("cleans its sandbox within the budget", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })

    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-perf-drill-"))
    const previousEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = isolatedRoot
    process.env.TMP = isolatedRoot
    process.env.TEMP = isolatedRoot

    try {
      const start = performance.now()
      await drillSnapshot(worktree, manifest.id)
      const elapsed = performance.now() - start

      const leftovers = (await fs.readdir(isolatedRoot)).filter((n) => n.startsWith("sdd-drill-"))
      expect(leftovers).toHaveLength(0)
      expect(elapsed).toBeLessThan(SNAPSHOT_DRILL_BUDGET_MS)
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(isolatedRoot, { recursive: true, force: true })
    }
  })
})