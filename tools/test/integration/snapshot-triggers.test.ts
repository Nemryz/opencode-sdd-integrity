import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import phaseTool from "../../speckit-phase"
import approveTool from "../../speckit-approve"
import auditTool from "../../speckit-audit"
import cleanTool from "../../speckit-clean"
import healthTool from "../../speckit-health"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  expectFeatureSpecJson,
  listSnapshotIds,
  listSnapshotTriggers,
  readProjectJson,
  snapshotDir,
  writeProjectFile,
} from "../helpers/assertions"
import { readDrillInfo, snapshotsDirPath } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots, readSnapshotManifest } from "../../shared/snapshot/manifest"
import { snapshotBeforeOperation } from "../../shared/snapshot/triggers"

let worktree: string
let ctx: ReturnType<typeof mockContext>

const GUARD_CONFIG = {
  version: 1,
  enabled: true,
  debug: false,
  protectedFiles: [],
  protectedAfterApproval: [],
  protectedByPhase: {},
  stats: { denied: 0, allowed: 0, asked: 0 },
  denials: [],
}

function makeSpecJson(overrides: Record<string, unknown> = {}) {
  return {
    feature_name: "Demo",
    feature_number: 1,
    title: "Demo",
    status: "approved",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase: "ready",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    spec_generated: true,
    plan_generated: true,
    tasks_generated: true,
    ready_for_implementation: true,
    active_delta: null,
    ...overrides,
  }
}

async function seedFeature(specJsonOverrides: Record<string, unknown> = {}): Promise<void> {
  await writeProjectFile(worktree, ".opencode/spec-memory/session.json", JSON.stringify({
    command: "/status",
    phase: "ready",
    featureDir: "001-demo",
    featureNumber: 1,
    featureName: "demo",
    nextStep: "/impl",
    lastResult: null,
    history: [],
  }))
  await writeProjectFile(worktree, ".opencode/spec-memory/constitution.md", "# Constitution\n")
  await writeProjectFile(worktree, ".opencode/guard.json", JSON.stringify(GUARD_CONFIG, null, 2))
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
  await writeProjectFile(worktree, "specs/001-demo/plan.md", "# Plan\n")
  await writeProjectFile(worktree, "specs/001-demo/tasks.md", "# Tasks\n")
  await writeProjectFile(worktree, "specs/001-demo/spec.json", JSON.stringify(makeSpecJson(specJsonOverrides), null, 2))
}

// Turns the snapshots folder into a plain file so snapshot creation fails with a filesystem error.
async function blockSnapshotsDir(): Promise<void> {
  await fs.writeFile(snapshotDir(worktree), "blocked", "utf-8")
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("snapshotBeforeOperation", () => {
  it("creates a verified, drilled snapshot tagged with the trigger", async () => {
    await seedFeature()
    const result = await snapshotBeforeOperation(worktree, "pre-fix:test")
    expect(result.ok).toBe(true)
    expect(result.reused).toBe(false)
    const manifest = await readSnapshotManifest(worktree, result.snapshotId!)
    expect(manifest?.trigger).toBe("pre-fix:test")
    expect(manifest?.feature).toBe("001-demo")
    const drill = await readDrillInfo(worktree, result.snapshotId!)
    expect(drill?.ok).toBe(true)
  })

  it("reuses the newest snapshot when the scope is unchanged", async () => {
    await seedFeature()
    const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
    const second = await snapshotBeforeOperation(worktree, "pre-fix:two")
    expect(second.ok).toBe(true)
    expect(second.reused).toBe(true)
    expect(second.snapshotId).toBe(first.snapshotId)
    expect((await listSnapshots(worktree)).length).toBe(1)
  })

  it("creates a new snapshot when the scope changed", async () => {
    await seedFeature()
    const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec v2\n")
    const second = await snapshotBeforeOperation(worktree, "pre-fix:two")
    expect(second.reused).toBe(false)
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect((await listSnapshots(worktree)).length).toBe(2)
  })

  it("does not reuse a snapshot whose copies failed verification", async () => {
    await seedFeature()
    const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
    await fs.appendFile(
      path.join(snapshotsDirPath(worktree), first.snapshotId!, "specs", "001-demo", "spec.md"),
      "corrupt",
      "utf-8",
    )
    const second = await snapshotBeforeOperation(worktree, "pre-fix:two")
    expect(second.ok).toBe(true)
    expect(second.reused).toBe(false)
    expect(second.snapshotId).not.toBe(first.snapshotId)
  })

  it("creates a new snapshot when the newest manifest is unreadable", async () => {
    await seedFeature()
    const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
    await fs.writeFile(path.join(snapshotsDirPath(worktree), first.snapshotId!, "manifest.json"), "CORRUPT", "utf-8")
    const second = await snapshotBeforeOperation(worktree, "pre-fix:two")
    expect(second.ok).toBe(true)
    expect(second.reused).toBe(false)
    expect(second.snapshotId).not.toBe(first.snapshotId)
  })
})

describe("phase tool trigger", () => {
  it("creates a pre-transition snapshot capturing the pre state", async () => {
    await seedFeature()
    const result = await phaseTool.execute({ phase: "impl" } as never, ctx)
    expect(result.title).toBe("Phase: impl")

    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers).toContain("phase:ready->impl")

    const snapshotIds = await listSnapshotIds(worktree)
    // The snapshot must hold the session as it was before the transition was written.
    const captured = await readProjectJson<{ phase: string }>(
      worktree,
      `.opencode/snapshots/${snapshotIds[0]}/.opencode/spec-memory/session.json`,
    )
    expect(captured.phase).toBe("ready")

    await expectFeatureSpecJson(worktree, "001-demo", { phase: "impl" })
  })

  it("blocks the transition when the snapshot cannot be created", async () => {
    await seedFeature()
    await blockSnapshotsDir()
    const result = await phaseTool.execute({ phase: "impl" } as never, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("BLOCKED")
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "ready" })
  })

  it("captures a post-failure snapshot when the transition write fails", async () => {
    await seedFeature()
    await fs.rm(path.join(worktree, ".opencode", "spec-memory", "session.json"))
    await fs.mkdir(path.join(worktree, ".opencode", "spec-memory", "session.json"))
    const result = await phaseTool.execute({ phase: "impl" } as never, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Post-failure snapshot:")
    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers.some(t => t.startsWith("post-failure"))).toBe(true)
  })
})

describe("approve tool trigger", () => {
  it("creates a snapshot before approving tasks", async () => {
    await seedFeature({
      phase: "tasks",
      ready_for_implementation: false,
      approvals: {
        spec: { generated: true, approved: true },
        plan: { generated: true, approved: true },
        tasks: { generated: true, approved: false },
      },
    })
    const result = await approveTool.execute({ artifact: "tasks", confirmed: true } as never, ctx)
    expect(result.title).toBe("tasks approved")
    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers).toContain("phase:tasks->ready")
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "ready" })
  })
})

describe("audit tool trigger", () => {
  it("creates a pre-fix snapshot and applies the fix", async () => {
    await seedFeature({ ready_for_implementation: false })
    await fs.rm(path.join(worktree, "specs", "001-demo", "tasks.md"))
    const result = await auditTool.execute({ fix: true } as never, ctx)
    expect(result.output).toContain("auto-fixed")
    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers).toContain("pre-fix:audit")
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "tasks" })
  })

  it("blocks fixes when the snapshot cannot be created", async () => {
    await seedFeature({ ready_for_implementation: false })
    await fs.rm(path.join(worktree, "specs", "001-demo", "tasks.md"))
    await blockSnapshotsDir()
    const result = await auditTool.execute({ fix: true } as never, ctx)
    expect(result.output).toContain("Fix blocked")
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "ready" })
  })
})

describe("clean tool trigger", () => {
  it("creates a pre-fix snapshot and repairs the phase", async () => {
    await seedFeature({ ready_for_implementation: false })
    await fs.rm(path.join(worktree, "specs", "001-demo", "tasks.md"))
    const result = await cleanTool.execute({ fix: true } as never, ctx)
    const issues = (result.metadata?.issues ?? []) as string[]
    expect(issues.some(i => i.includes("Fix blocked"))).toBe(false)
    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers).toContain("pre-fix:clean")
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "tasks" })
  })

  it("blocks repairs when the snapshot cannot be created", async () => {
    await seedFeature({ ready_for_implementation: false })
    await fs.rm(path.join(worktree, "specs", "001-demo", "tasks.md"))
    await blockSnapshotsDir()
    const result = await cleanTool.execute({ fix: true } as never, ctx)
    const issues = (result.metadata?.issues ?? []) as string[]
    expect(issues.some(i => i.includes("Fix blocked"))).toBe(true)
    await expectFeatureSpecJson(worktree, "001-demo", { phase: "ready" })
  })
})

describe("health tool trigger", () => {
  it("creates a pre-fix snapshot before applying fixes", async () => {
    await seedFeature()
    const result = await healthTool.execute({ fix: true } as never, ctx)
    expect(result.output).toContain("Recovery Readiness:")
    const triggers = await listSnapshotTriggers(worktree)
    expect(triggers).toContain("pre-fix:health")
  })
})
