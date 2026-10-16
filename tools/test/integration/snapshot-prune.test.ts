import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { expectFileContent, projectPath, writePendingRestoreJournal, writeProjectFile } from "../helpers/assertions"
import { createSnapshot, listSnapshots } from "../../shared/snapshot/manifest"
import { drillSnapshot, pinSnapshot, pruneSnapshots } from "../../shared/snapshot/retention"

let worktree: string

// Snapshot ids are stamped with local time, so build the fixture from local components.
function date(sec: number): Date {
  return new Date(2026, 0, 1, 10, 0, sec)
}

async function make(trigger: string, feature: string | null, sec: number): Promise<string> {
  const manifest = await createSnapshot(worktree, { trigger, feature, now: date(sec) })
  return manifest.id
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  await writeProjectFile(worktree, ".opencode/spec-memory/constitution.md", "# Constitution\n")
  await writeProjectFile(worktree, ".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("pruneSnapshots", () => {
  it("does nothing when there are no snapshots", async () => {
    const report = await pruneSnapshots(worktree)
    expect(report.removed).toEqual([])
    expect(report.kept).toBe(0)
    expect(report.aborted).toBe(false)
  })

  it("keeps the per-feature automatic cap of 5, removing the oldest", async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await make("pre-fix-audit", "001-a", i))

    const report = await pruneSnapshots(worktree)

    expect(report.aborted).toBe(false)
    expect(report.removed).toEqual([ids[0]])
    expect(report.kept).toBe(5)
    const remaining = (await listSnapshots(worktree)).map((e) => e.id)
    expect(remaining).toHaveLength(5)
    expect(remaining).not.toContain(ids[0])
  })

  it("prunes oldest autos before manuals when over the total cap", async () => {
    const autos: string[] = []
    for (let i = 0; i < 4; i++) autos.push(await make("pre-fix-audit", "001-a", i))
    for (let i = 0; i < 4; i++) autos.push(await make("pre-fix-audit", "001-b", 10 + i))
    const manuals: string[] = []
    for (let i = 0; i < 4; i++) manuals.push(await make("manual", null, 20 + i))

    const report = await pruneSnapshots(worktree)

    expect(report.kept).toBe(10)
    expect(report.removed).toHaveLength(2)
    for (const id of report.removed) {
      expect(autos).toContain(id)
    }
    for (const id of manuals) {
      expect(report.removed).not.toContain(id)
    }
  })

  it("prunes lower-value triggers first within the same feature", async () => {
    const phaseId = await make("phase:spec->plan", "001-a", 0)
    const prefx: string[] = []
    for (let i = 1; i <= 5; i++) prefx.push(await make("pre-fix-audit", "001-a", i))

    const report = await pruneSnapshots(worktree)

    expect(report.removed).toEqual([prefx[0]])
    expect(report.removed).not.toContain(phaseId)
  })

  it("never removes the newest snapshot", async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await make("pre-fix-audit", "001-a", i))
    const report = await pruneSnapshots(worktree)
    expect(report.removed).not.toContain(ids[5])
  })

  it("never removes pinned snapshots and reports them as protected", async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await make("pre-fix-audit", "001-a", i))
    await pinSnapshot(worktree, ids[0], "keep me")

    const report = await pruneSnapshots(worktree)

    expect(report.removed).not.toContain(ids[0])
    expect(report.removed).toEqual([ids[1]])
    expect(report.protectedIds).toContain(ids[0])
  })

  it("never removes the last drilled-ok snapshot", async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await make("pre-fix-audit", "001-a", i))
    await drillSnapshot(worktree, ids[0])

    const report = await pruneSnapshots(worktree)

    expect(report.removed).not.toContain(ids[0])
    expect(report.removed).toEqual([ids[1]])
  })

  it("aborts when a restore journal exists", async () => {
    const safety = await make("pre-restore:x", null, 0)
    const target = await make("manual", null, 1)
    await writePendingRestoreJournal(worktree, { snapshotId: target, safetySnapshotId: safety })

    const report = await pruneSnapshots(worktree)

    expect(report.aborted).toBe(true)
    expect(report.removed).toEqual([])
    expect(report.abortReason).toContain("journal")
    expect((await listSnapshots(worktree)).length).toBe(2)
  })

  it("reports unreadable snapshot directories without removing them", async () => {
    await make("manual", null, 0)
    await fs.mkdir(projectPath(worktree, ".opencode/snapshots/20990101-000000-ghost"), { recursive: true })

    const report = await pruneSnapshots(worktree)

    expect(report.unreadable).toContain("20990101-000000-ghost")
    const ghost = (await listSnapshots(worktree)).find((entry) => entry.id === "20990101-000000-ghost")
    expect(ghost?.status).toBe("unreadable")
  })

  it("touches nothing outside the snapshots directory", async () => {
    for (let i = 0; i < 6; i++) await make("pre-fix-audit", "001-a", i)
    await writeProjectFile(worktree, "specs/001-demo/keep.md", "keep\n")

    await pruneSnapshots(worktree)

    await expectFileContent(worktree, "specs/001-demo/keep.md", "keep\n")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
  })

  it("is idempotent", async () => {
    for (let i = 0; i < 6; i++) await make("pre-fix-audit", "001-a", i)
    await pruneSnapshots(worktree)
    const second = await pruneSnapshots(worktree)
    expect(second.removed).toEqual([])
    expect(second.kept).toBe(5)
  })
})
