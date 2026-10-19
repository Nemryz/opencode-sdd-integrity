import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import phaseTool from "../../speckit-phase"
import validateTool from "../../speckit-validate"
import statusTool from "../../speckit-status"
import auditTool from "../../speckit-audit"
import cleanTool from "../../speckit-clean"
import healthTool from "../../speckit-health"
import snapshotTool from "../../speckit-snapshot"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import {
  expectFileExists,
  expectFeatureSpecJson,
  expectRestoreJournal,
  expectSessionState,
  listSnapshotTriggers,
  readProjectFile,
  snapshotDir,
  writeProjectFile,
} from "../helpers/assertions"
import { readRestoreJournal, writeRestoreJournal } from "../../shared/snapshot/paths"

let worktree: string
let ctx: ReturnType<typeof mockContext>

interface ToolOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

// Calls any kit tool with a plain argument object and returns a readable shape for assertions.
async function run(
  tool: { execute: (args: never, context: ToolContext) => Promise<ToolOutput> },
  args: Record<string, unknown> = {},
): Promise<ToolOutput> {
  return tool.execute(args as never, ctx)
}

// Counts the snapshots whose trigger starts with a prefix so suffixed triggers still match.
async function snapshotsFor(triggerPrefix: string): Promise<number> {
  const triggers = await listSnapshotTriggers(worktree)
  return triggers.filter(trigger => trigger.startsWith(triggerPrefix)).length
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  await createConstitution(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("e2e workflow: specification to completion with verified recovery points", () => {
  it("walks the whole lifecycle and guards every transition with a snapshot", async () => {
    // Specification stage creates the feature and records the pending approval.
    const spec = await run(scaffoldTool, { featureName: "User Auth", template: "spec" })
    expect(spec.metadata?.featureDir).toBe("001-user-auth")
    expect(spec.metadata?.phase).toBe("spec")
    await expectFeatureSpecJson(worktree, "001-user-auth", { phase: "spec" })

    // Approving the specification records the approval and moves the workflow forward.
    const approvedSpec = await run(approveTool, { artifact: "spec", confirmed: true })
    expect(approvedSpec.title).toBe("spec approved")
    expect(await snapshotsFor("phase:spec->plan")).toBe(0)

    // Planning stage adds the plan artifact and keeps the approval chain intact.
    await run(scaffoldTool, { featureName: "User Auth", template: "plan", techStack: "Node.js" })
    await run(approveTool, { artifact: "plan", confirmed: true })
    await expectFeatureSpecJson(worktree, "001-user-auth", { phase: "plan" })

    // Task stage completes the artifacts and the approval that unlocks implementation.
    await run(scaffoldTool, { featureName: "User Auth", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await expectFeatureSpecJson(worktree, "001-user-auth", { phase: "ready" })
    expect(await snapshotsFor("phase:tasks->ready")).toBe(1)

    // Entering implementation must capture the ready state before the phase changes.
    const impl = await run(phaseTool, { phase: "impl" })
    expect(impl.title).toBe("Phase: impl")
    expect(await snapshotsFor("phase:ready->impl")).toBe(1)
    await expectFeatureSpecJson(worktree, "001-user-auth", { phase: "impl" })
    await expectSessionState(worktree, { phase: "impl", featureDir: "001-user-auth" })

    // Closing the feature must capture the implementation state before the phase changes.
    const done = await run(phaseTool, { phase: "complete" })
    expect(done.title).toBe("Phase: complete")
    expect(await snapshotsFor("phase:impl->complete")).toBe(1)
    await expectFeatureSpecJson(worktree, "001-user-auth", { phase: "complete" })

    // Every automatic snapshot must be drilled so recovery readiness stays green.
    const listed = await run(snapshotTool, { subcommand: "list" })
    expect(listed.title).toBe("Snapshots: READY")
    expect(listed.output).not.toContain("DEGRADED")
  })

  it("keeps the workflow consistent when a repair run repairs the phase", async () => {
    await run(scaffoldTool, { featureName: "Billing", template: "spec" })
    await run(scaffoldTool, { featureName: "Billing", template: "plan" })
    await run(scaffoldTool, { featureName: "Billing", template: "tasks" })

    // Approving tasks puts the feature in the ready phase.
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await expectFeatureSpecJson(worktree, "001-billing", { phase: "ready" })

    // Removing the tasks file makes the state disagree with the artifacts on disk.
    await fs.rm(path.join(worktree, "specs", "001-billing", "tasks.md"))
    const audit = await run(auditTool, {})
    expect(audit.metadata?.errorCount).toBeGreaterThan(0)

    // The repair run must take a recovery point and realign the stored phase with the artifacts that remain.
    const repair = await run(auditTool, { fix: true })
    expect(repair.output).toContain("auto-fixed")
    expect(await snapshotsFor("pre-fix:audit")).toBeGreaterThan(0)
    await expectFeatureSpecJson(worktree, "001-billing", { phase: "plan", ready_for_implementation: false })

    // A second audit run must find the repaired state coherent.
    const reaudit = await run(auditTool, {})
    expect(reaudit.metadata?.errorCount).toBe(0)

    // A clean sweep must agree with the repaired state and find nothing left to fix.
    const sweep = await run(cleanTool, {})
    const cleanIssues = (sweep.metadata?.issues ?? []) as string[]
    expect(cleanIssues.filter(issue => issue.includes("Fix blocked"))).toHaveLength(0)
  })

  it("recovers an interrupted restore in the middle of a workflow", async () => {
    await run(scaffoldTool, { featureName: "Recovery", template: "spec" })
    await run(scaffoldTool, { featureName: "Recovery", template: "plan" })
    await run(scaffoldTool, { featureName: "Recovery", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await run(phaseTool, { phase: "impl" })

    // A safety snapshot stands in for the state that an interrupted restore must roll back to.
    const safety = await run(snapshotTool, { subcommand: "create" })
    const safetyId = safety.metadata?.snapshotId as string

    // A journal without a matching restore leaves the workflow in an inconsistent shape.
    await writeProjectFile(worktree, "specs/001-recovery/spec.md", "# Half restored\n")
    await writeProjectFile(worktree, "specs/001-recovery/extra.md", "extra\n")
    await writeRestoreJournal(worktree, {
      format: 1,
      snapshot_id: "20990101-000000-manual",
      safety_snapshot_id: safetyId,
      mode: "full",
      started_at: new Date().toISOString(),
      files: [],
      removed: [],
    })
    expect(await readRestoreJournal(worktree)).not.toBeNull()

    // A plain health report must warn without touching the pending restore.
    const reported = await run(healthTool, {})
    expect(reported.output).toContain("Interrupted restore pending")
    expect(await readRestoreJournal(worktree)).not.toBeNull()

    // A status call must warn too so the workflow never hides an interrupted restore.
    const status = await run(statusTool, {})
    expect(status.output).toContain("[INTERRUPTED RESTORE] pending")

    // The repair run rolls back to the safety snapshot and clears the journal on disk.
    const repaired = await run(healthTool, { fix: true })
    expect(repaired.output).toContain("recovered from safety snapshot")
    await expectRestoreJournal(worktree, false)
    await expectFileExists(worktree, "specs/001-recovery/spec.md")
    const restoredSpec = await readProjectFile(worktree, "specs/001-recovery/spec.md")
    expect(restoredSpec).toContain("spec: Recovery")
    await expectSessionState(worktree, { featureDir: "001-recovery" })

    // Validation must accept the recovered workflow without a manual repair.
    const validated = await run(validateTool, { featureDir: "001-recovery" })
    expect(validated.metadata?.phase).toBe("impl")
  })

  it("restores the workflow to an earlier milestone and continues from there", async () => {
    await run(scaffoldTool, { featureName: "Time Travel", template: "spec" })
    await run(scaffoldTool, { featureName: "Time Travel", template: "plan" })
    await run(approveTool, { artifact: "plan", confirmed: true })

    // The snapshot taken here is the point the workflow returns to later.
    const mark = await run(snapshotTool, { subcommand: "create" })
    const markId = mark.metadata?.snapshotId as string
    expect(mark.output).toContain(markId)

    // The workflow moves forward and creates state that the restore must discard.
    await run(scaffoldTool, { featureName: "Time Travel", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await run(phaseTool, { phase: "impl" })
    await expectFeatureSpecJson(worktree, "001-time-travel", { phase: "impl" })
    await expectFileExists(worktree, "specs/001-time-travel/tasks.md")

    // A preview shows the impact without changing anything on disk.
    const preview = await run(snapshotTool, { subcommand: "preview", id: markId })
    expect(preview.output).toContain(`Preview restore ${markId}`)
    await expectFileExists(worktree, "specs/001-time-travel/tasks.md")

    // The confirmed restore returns the feature to the plan phase and removes later artifacts.
    const restored = await run(snapshotTool, { subcommand: "restore", id: markId, confirmed: true })
    expect(restored.title).toBe("Restore Complete")
    await expectFeatureSpecJson(worktree, "001-time-travel", { phase: "plan" })
    const tasksFile = await fs.stat(path.join(worktree, "specs", "001-time-travel", "tasks.md")).catch(() => null)
    expect(tasksFile).toBeNull()

    // The workflow continues normally after the restore with a fresh recovery point.
    await run(scaffoldTool, { featureName: "Time Travel", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await expectFeatureSpecJson(worktree, "001-time-travel", { phase: "ready" })
    expect(await snapshotsFor("pre-restore:")).toBe(1)
  })

  it("blocks a destructive operation when the recovery point cannot be created", async () => {
    await run(scaffoldTool, { featureName: "Blocked", template: "spec" })
    await run(scaffoldTool, { featureName: "Blocked", template: "plan" })
    await run(scaffoldTool, { featureName: "Blocked", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })

    // Removing the tasks artifact creates a phase mismatch that the repair run must fix.
    await fs.rm(path.join(worktree, "specs", "001-blocked", "tasks.md"))

    // A plain file in the snapshots folder makes snapshot creation impossible.
    await fs.rm(snapshotDir(worktree), { recursive: true, force: true })
    await writeProjectFile(worktree, ".opencode/snapshots", "blocked")

    // The repair run must refuse to change anything and say why.
    const blocked = await run(auditTool, { fix: true })
    expect(blocked.output).toContain("Fix blocked")
    await expectFeatureSpecJson(worktree, "001-blocked", { phase: "ready" })

    // The validation gate keeps working because nothing was modified.
    const validated = await run(validateTool, { featureDir: "001-blocked" })
    expect(validated.metadata?.phase).toBe("tasks")
  })
})