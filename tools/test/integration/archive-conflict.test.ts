import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

vi.mock("../../shared/state/apply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/state/apply")>()
  const { StateTransactionError } = await import("../../shared/state/plan")
  return {
    ...actual,
    applyStatePlan: async () => {
      throw new StateTransactionError("TARGET_EXISTS", "target appeared during apply")
    },
  }
})

const { default: archiveTool } = await import("../../speckit-archive")

let worktree: string
let ctx: ReturnType<typeof mockContext>

async function writeFeature(): Promise<void> {
  const base = path.join(worktree, "specs", "001-demo")
  await fs.mkdir(base, { recursive: true })
  await fs.writeFile(path.join(base, "spec.md"), "# Demo\n", "utf-8")
  await fs.writeFile(path.join(base, "spec.json"), JSON.stringify({
    feature_name: "demo",
    feature_number: 1,
    phase: "complete",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    ready_for_implementation: true,
    active_delta: null,
    converged: true,
  }), "utf-8")
}

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-conflict-"))
  ctx = mockContext(worktree)
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await destroyTempWorktree(worktree)
})

describe("archive conflict", () => {
  it("reports a stable conflict after two raced targets without moving the feature", async () => {
    await writeFeature()
    const result = await archiveTool.execute({ featureDir: "001-demo", confirmed: true }, ctx)
    expect(result).toEqual({
      title: "Conflict",
      output: "Archive target kept changing for 001-demo. Nothing was moved; retry when the archive directory is stable.",
    })
    expect(await fs.access(path.join(worktree, "specs", "001-demo", "spec.md")).then(() => true).catch(() => false)).toBe(true)
    expect(await fs.readdir(path.join(worktree, "archive")).catch(() => [])).toEqual([])
  })
})
