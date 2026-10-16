import { describe, it, expect, beforeEach, afterEach } from "vitest"
import healthTool from "../../speckit-health"
import statusTool from "../../speckit-status"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  expectFileContent,
  expectPathMissing,
  expectRestoreJournal,
  expectSessionState,
  writeProjectFile,
} from "../helpers/assertions"
import { readRestoreJournal, writeRestoreJournal } from "../../shared/snapshot/paths"
import { createSnapshot } from "../../shared/snapshot/manifest"

let worktree: string
let ctx: ReturnType<typeof mockContext>

async function seedFeature(): Promise<void> {
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
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
}

async function writePendingJournal(safetySnapshotId: string): Promise<void> {
  await writeRestoreJournal(worktree, {
    format: 1,
    snapshot_id: "20990101-000000-manual",
    safety_snapshot_id: safetySnapshotId,
    mode: "full",
    started_at: new Date().toISOString(),
    files: [],
    removed: [],
  })
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("health restore recovery", () => {
  it("reports a pending interrupted restore and keeps the journal on disk", async () => {
    await seedFeature()
    await writePendingJournal("20990101-000000-missing")

    const result = await healthTool.execute({} as never, ctx)

    expect(result.output).toContain("Interrupted restore pending")
    expect(result.output).toContain("Recovery Readiness: NOT READY")
    expect(await readRestoreJournal(worktree)).not.toBeNull()
  })

  it("recovers the interrupted restore and clears the journal on disk", async () => {
    await seedFeature()
    const safety = await createSnapshot(worktree, { trigger: "pre-restore:crash" })
    await writePendingJournal(safety.id)
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Half restored\n")
    await writeProjectFile(worktree, "specs/001-demo/extra.md", "extra\n")

    const result = await healthTool.execute({ fix: true } as never, ctx)

    expect(result.output).toContain(`recovered from safety snapshot ${safety.id}`)
    // Recovery must bring back the captured content and drop files the restore created.
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
    await expectPathMissing(worktree, "specs/001-demo/extra.md")
    await expectRestoreJournal(worktree, false)

    // The health pass that follows the recovery must leave the session untouched and valid.
    await expectSessionState(worktree, { phase: "ready", featureDir: "001-demo" })
  })

  it("includes snapshot recovery readiness in the report", async () => {
    await seedFeature()
    const result = await healthTool.execute({} as never, ctx)
    expect(result.output).toContain("Snapshots: 0 | Recovery Readiness: NOT READY")
    expect(result.output).toContain("no snapshots yet")
  })

  it("restores a corrupted guard.json from backup and validates the result", async () => {
    await seedFeature()
    const guardTool = (await import("../../speckit-guard")).default
    await guardTool.execute({ subcommand: "on" } as never, ctx)
    await guardTool.execute({ subcommand: "off", confirmed: true } as never, ctx)
    await writeProjectFile(worktree, ".opencode/guard.json", "NOT JSON")

    const result = await healthTool.execute({ fix: true } as never, ctx)

    expect(result.output).toContain("guard.json: restored from backup")
    const { expectFileExists, expectSchemaValid, readProjectJson } = await import("../helpers/assertions")
    const { GuardConfigSchema } = await import("../../plugins/speckit-guard")
    await expectFileExists(worktree, ".opencode/guard.json")
    expectSchemaValid(GuardConfigSchema, await readProjectJson(worktree, ".opencode/guard.json"))
  })
})

describe("status journal warning", () => {
  it("warns when an interrupted restore is pending and leaves the state intact", async () => {
    await seedFeature()
    await writePendingJournal("20990101-000000-missing")

    const result = await statusTool.execute({} as never, ctx)

    expect(result.output).toContain("[INTERRUPTED RESTORE] pending")
    expect(result.metadata?.interruptedRestore).toBe(true)
    // Status keeps the journal untouched and only syncs the session phase with the artifacts on disk.
    expect(await readRestoreJournal(worktree)).not.toBeNull()
    await expectSessionState(worktree, { featureDir: "001-demo" })
  })
})