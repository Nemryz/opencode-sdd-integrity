import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { tamperSnapshotFile, writeProjectFile } from "../helpers/assertions"
import { readDrillInfo, readPinInfo } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots } from "../../shared/snapshot/manifest"
import { drillSnapshot, pinSnapshot, pruneSnapshots, unpinSnapshot } from "../../shared/snapshot/retention"

let worktree: string

// Snapshot ids are stamped with local time (not UTC), so build the fixture from local components.
const FIXED_NOW = new Date(2026, 2, 4, 5, 6, 7)

beforeEach(async () => {
  worktree = await createTempWorktree()
  await writeProjectFile(worktree, ".opencode/spec-memory/session.json", JSON.stringify({ phase: "plan" }))
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("matrix: snapshot id slug from trigger", () => {
  it.each([
    ["manual", "manual"],
    ["pre-fix:audit", "pre-fix-audit"],
    ["phase:ready->impl", "phase-ready-impl"],
    ["Phase: Ready To Impl", "phase-ready-to-impl"],
    ["with   multiple    spaces", "with-multiple-spaces"],
    ["trailing---dashes---", "trailing-dashes"],
    ["__leading_and_trailing__", "leading-and-trailing"],
    ["MiXeD CaSe", "mixed-case"],
    ["digits-123-keep", "digits-123-keep"],
    ["!!!", "snapshot"],
    ["日本語のみ", "snapshot"],
  ])("trigger %j -> slug %j", async (trigger, expectedSlug) => {
    const manifest = await createSnapshot(worktree, { trigger, now: FIXED_NOW })
    expect(manifest.id).toBe(`20260304-050607-${expectedSlug}`)
  })

  it("rejects an empty trigger at the manifest schema boundary", async () => {
    await expect(createSnapshot(worktree, { trigger: "", now: FIXED_NOW })).rejects.toThrow()
  })

  it("truncates long triggers to 30 slug characters", async () => {
    const manifest = await createSnapshot(worktree, {
      trigger: "a".repeat(40),
      now: FIXED_NOW,
    })
    expect(manifest.id).toBe(`20260304-050607-${"a".repeat(30)}`)
  })

  it("keeps the YYYYMMDD-HHmmss timestamp prefix zero-padded", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual", now: new Date(2026, 0, 2, 3, 4, 5) })
    expect(manifest.id).toMatch(/^\d{8}-\d{6}-manual$/)
    expect(manifest.id.startsWith("20260102-030405")).toBe(true)
  })

  it("suffixes -2, -3 on same-second collisions", async () => {
    const first = await createSnapshot(worktree, { trigger: "manual", now: FIXED_NOW })
    const second = await createSnapshot(worktree, { trigger: "manual", now: FIXED_NOW })
    const third = await createSnapshot(worktree, { trigger: "manual", now: FIXED_NOW })
    expect([first.id, second.id, third.id]).toEqual([
      "20260304-050607-manual",
      "20260304-050607-manual-2",
      "20260304-050607-manual-3",
    ])
  })
})

describe("matrix: pin and label", () => {
  it.each([
    ["with label", "golden"],
    ["empty label", null],
    ["unicode label", "estado-ñ-✓"],
  ])("pin %s round-trips", async (_label, label) => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await pinSnapshot(worktree, manifest.id, label)

    const pin = await readPinInfo(worktree, manifest.id)
    expect(pin?.label).toBe(label)

    const entry = (await listSnapshots(worktree)).find(e => e.id === manifest.id)
    expect(entry?.pinned).toBe(true)
    expect(entry?.label).toBe(label)
  })

  it("unpin removes the pin and is idempotent", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await pinSnapshot(worktree, manifest.id, "x")
    expect(await unpinSnapshot(worktree, manifest.id)).toBe(true)
    expect(await unpinSnapshot(worktree, manifest.id)).toBe(false)
    const entry = (await listSnapshots(worktree)).find(e => e.id === manifest.id)
    expect(entry?.pinned).toBe(false)
    expect(entry?.label).toBeNull()
  })
})

describe("matrix: drill results", () => {
  it.each([
    ["healthy snapshot", false],
    ["snapshot with corrupted copy", true],
  ])("%s -> drill ok=%s", async (_label, corrupt) => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    if (corrupt) {
      await tamperSnapshotFile(worktree, manifest.id, "specs/001-demo/spec.md", "corrupt")
    }
    const drill = await drillSnapshot(worktree, manifest.id)
    expect(drill.ok).toBe(!corrupt)

    const entry = (await listSnapshots(worktree)).find(e => e.id === manifest.id)
    expect(entry?.drill).toBe(corrupt ? "failed" : "ok")
    expect((await readDrillInfo(worktree, manifest.id))?.ok).toBe(!corrupt)
  })

  it("reports drill as never before the first run", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const entry = (await listSnapshots(worktree)).find(e => e.id === manifest.id)
    expect(entry?.drill).toBe("never")
  })
})

describe("matrix: list entry status", () => {
  it.each([
    ["pristine snapshot", false, "verified"],
    ["corrupted manifest", true, "unreadable"],
  ])("%s -> %s", async (_label, corrupt, expected) => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    if (corrupt) {
      await tamperSnapshotFile(worktree, manifest.id, "manifest.json", "garbage")
    }
    const entry = (await listSnapshots(worktree)).find(e => e.id === manifest.id)
    expect(entry?.status).toBe(expected)
  })

  it("lists zero snapshots on an empty project", async () => {
    expect(await listSnapshots(worktree)).toEqual([])
  })
})

describe("matrix: prune priority by trigger", () => {
  // AUTO_CAP_PER_FEATURE is 5, so 7 automatic snapshots force exactly two removals.
  async function seedOverCap(): Promise<Record<string, string[]>> {
    const ids: Record<string, string[]> = { manual: [], phase: [], preRestore: [], preFix: [] }
    let offset = 0
    const create = async (trigger: string, bucket: string) => {
      const manifest = await createSnapshot(worktree, {
        trigger,
        now: new Date(FIXED_NOW.getTime() + offset++ * 1000),
      })
      ids[bucket].push(manifest.id)
    }
    await create("manual", "manual")
    await create("phase:ready->impl", "phase")
    await create("phase:impl->complete", "phase")
    await create("pre-restore:x", "preRestore")
    await create("pre-restore:y", "preRestore")
    await create("pre-fix:audit", "preFix")
    await create("pre-fix:clean", "preFix")
    await create("pre-fix:health", "preFix")
    return ids
  }

  it("removes only pre-fix snapshots while higher-value triggers survive", async () => {
    const ids = await seedOverCap()
    const report = await pruneSnapshots(worktree)

    expect(report.removed.length).toBe(2)
    for (const id of report.removed) {
      expect(ids.preFix).toContain(id)
    }
    // newest snapshot is protected, so only the two oldest pre-fix entries go
    expect(report.removed).not.toContain(ids.preFix[2])
    expect(report.removed).not.toContain(ids.manual[0])
    expect(report.removed).not.toContain(ids.phase[0])
    expect(report.removed).not.toContain(ids.preRestore[0])
  })

  it("never prunes a pinned snapshot and falls through to the next trigger value", async () => {
    const ids = await seedOverCap()
    await pinSnapshot(worktree, ids.preFix[0], "keep")

    const report = await pruneSnapshots(worktree)
    expect(report.removed).not.toContain(ids.preFix[0])
    expect(report.protectedIds).toContain(ids.preFix[0])
    expect(report.removed).toContain(ids.preFix[1])
    expect(report.removed).toContain(ids.preRestore[0])
    expect(report.removed).not.toContain(ids.manual[0])
  })

  it("keeps everything when under the caps", async () => {
    await createSnapshot(worktree, { trigger: "manual" })
    await createSnapshot(worktree, { trigger: "pre-fix:audit" })
    await createSnapshot(worktree, { trigger: "pre-fix:clean" })
    const report = await pruneSnapshots(worktree)
    expect(report.removed).toEqual([])
    expect(report.aborted).toBe(false)
    expect(report.kept).toBe(3)
  })
})