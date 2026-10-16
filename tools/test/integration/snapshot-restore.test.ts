import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  expectFileContent,
  expectPathMissing,
  expectRestoreJournal,
  projectPath,
  snapshotFilePath,
  tamperSnapshotFile,
  writePendingRestoreJournal,
  writeProjectFile,
} from "../helpers/assertions"
import { clearRestoreJournal } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots } from "../../shared/snapshot/manifest"
import { previewRestore, recoverInterruptedRestore, restoreSnapshot } from "../../shared/snapshot/restore"

const state = vi.hoisted(() => ({ failProjectWrites: 0 }))

vi.mock("../../shared/io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/io")>()
  return {
    ...actual,
    atomicWriteFile: async (fp: string, data: string | Buffer) => {
      if (state.failProjectWrites > 0 && !String(fp).includes("snapshots")) {
        state.failProjectWrites--
        throw new Error("injected write failure")
      }
      return actual.atomicWriteFile(fp, data)
    },
  }
})

let worktree: string

beforeEach(async () => {
  state.failProjectWrites = 0
  worktree = await createTempWorktree()
  await writeProjectFile(
    worktree,
    ".opencode/spec-memory/session.json",
    JSON.stringify({
      command: null,
      phase: "init",
      featureDir: null,
      featureNumber: null,
      featureName: null,
      nextStep: "/spec <description>",
      lastResult: null,
      history: [],
    }),
  )
  await writeProjectFile(
    worktree,
    ".opencode/spec-memory/config.json",
    JSON.stringify({
      defaultTechStack: null,
      lastUsedLanguage: null,
      expressMode: false,
      autoVersioning: false,
      preferences: {},
    }),
  )
  await writeProjectFile(worktree, ".opencode/spec-memory/constitution.md", "# Constitution\n")
  await writeProjectFile(worktree, ".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await writeProjectFile(worktree, ".opencode/steering/product.md", "# Product\n")
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
  await writeProjectFile(worktree, "specs/001-demo/plan.md", "# Plan\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("restoreSnapshot confirmation gate", () => {
  it("refuses without confirmed and changes nothing", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    const before = await listSnapshots(worktree)

    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: false })).rejects.toThrow(/confirmed/)

    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Changed\n")
    expect(await listSnapshots(worktree)).toEqual(before)
    await expectRestoreJournal(worktree, false)
  })

  it("refuses when the snapshot fails verification", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await tamperSnapshotFile(worktree, manifest.id, "specs/001-demo/spec.md")
    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/verification/)
  })
})

describe("restoreSnapshot full", () => {
  it("restores changed files byte-identical", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await writeProjectFile(worktree, ".opencode/steering/product.md", "# Other\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(report.restored).toContain("specs/001-demo/spec.md")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
    await expectFileContent(worktree, ".opencode/steering/product.md", "# Product\n")
    expect(report.safetySnapshotId).toBeDefined()
  })

  it("re-creates files missing from the current state", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.rm(projectPath(worktree, "specs/001-demo/plan.md"))
    await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    await expectFileContent(worktree, "specs/001-demo/plan.md", "# Plan\n")
  })

  it("removes extras so the state matches the snapshot exactly (point-in-time)", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/extra.md", "extra\n")
    await writeProjectFile(worktree, ".opencode/steering/extra.md", "extra\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(report.removed).toContain("specs/001-demo/extra.md")
    await expectPathMissing(worktree, "specs/001-demo/extra.md")
    await expectPathMissing(worktree, ".opencode/steering/extra.md")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
  })

  it("takes a pre-restore safety snapshot of the current state", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    const safety = (await listSnapshots(worktree)).find((s) => s.id === report.safetySnapshotId)
    expect(safety?.trigger).toBe(`pre-restore:${manifest.id}`)

    const safetyCopy = await fs.readFile(
      snapshotFilePath(worktree, report.safetySnapshotId, "specs/001-demo/spec.md"),
      "utf-8",
    )
    expect(safetyCopy).toBe("# Changed\n")
  })

  it("is idempotent when the state already matches", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    const second = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(second.removed).toEqual([])
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
  })
})

describe("restoreSnapshot rollback", () => {
  it("rolls back to the pre-restore state when a write fails mid-apply", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await writeProjectFile(worktree, "specs/001-demo/extra.md", "extra\n")
    await fs.rm(projectPath(worktree, ".opencode/steering/product.md"))

    state.failProjectWrites = 1
    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/rolled back/)

    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await expectFileContent(worktree, "specs/001-demo/extra.md", "extra\n")
    await expectPathMissing(worktree, ".opencode/steering/product.md")
    await expectRestoreJournal(worktree, false)
  })
})

describe("restoreSnapshot selective", () => {
  it("restores only the requested files", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await writeProjectFile(worktree, "specs/001-demo/plan.md", "# Changed Plan\n")

    const report = await restoreSnapshot(worktree, manifest.id, {
      confirmed: true,
      mode: "selective",
      files: ["specs/001-demo/spec.md"],
    })
    expect(report.restored).toEqual(["specs/001-demo/spec.md"])
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
    await expectFileContent(worktree, "specs/001-demo/plan.md", "# Changed Plan\n")
  })

  it("refuses paths that are not in the snapshot manifest", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await expect(
      restoreSnapshot(worktree, manifest.id, { confirmed: true, mode: "selective", files: ["specs/001-demo/nope.md"] }),
    ).rejects.toThrow(/not in snapshot manifest/)
  })

  it("refuses traversal paths", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await expect(
      restoreSnapshot(worktree, manifest.id, { confirmed: true, mode: "selective", files: ["../evil.md"] }),
    ).rejects.toThrow(/unsafe/)
  })

  it("requires at least one file", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await expect(
      restoreSnapshot(worktree, manifest.id, { confirmed: true, mode: "selective", files: [] }),
    ).rejects.toThrow(/at least one file/)
  })
})

describe("previewRestore", () => {
  it("reports identical, changed, missing, and extra entries without writing", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await fs.rm(projectPath(worktree, "specs/001-demo/plan.md"))
    await writeProjectFile(worktree, "specs/001-demo/extra.md", "extra\n")

    const before = await listSnapshots(worktree)
    const preview = await previewRestore(worktree, manifest.id)

    expect(preview.entries.find((e) => e.path === "specs/001-demo/spec.md")?.status).toBe("changed")
    expect(preview.entries.find((e) => e.path === "specs/001-demo/plan.md")?.status).toBe("missing")
    expect(preview.entries.find((e) => e.path === ".opencode/guard.json")?.status).toBe("identical")
    expect(preview.extras).toContain("specs/001-demo/extra.md")

    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Changed\n")
    expect(await listSnapshots(worktree)).toEqual(before)
    await expectRestoreJournal(worktree, false)
  })

  it("limits the preview to the requested files in selective mode", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")
    await writeProjectFile(worktree, "specs/001-demo/plan.md", "# Changed Plan\n")

    const preview = await previewRestore(worktree, manifest.id, {
      mode: "selective",
      files: ["specs/001-demo/plan.md"],
    })
    expect(preview.entries.map((e) => e.path)).toEqual(["specs/001-demo/plan.md"])
    expect(preview.extras).toEqual([])
  })

  it("reports errors for paths not in the manifest", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const preview = await previewRestore(worktree, manifest.id, { mode: "selective", files: ["../evil.md"] })
    expect(preview.errors.length).toBeGreaterThan(0)
  })
})

describe("recoverInterruptedRestore", () => {
  it("rolls back to the safety snapshot when an orphan journal exists", async () => {
    const safety = await createSnapshot(worktree, { trigger: "pre-restore:crash" })
    await writePendingRestoreJournal(worktree, {
      snapshotId: "20990101-000000-manual",
      safetySnapshotId: safety.id,
    })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Half restored\n")
    await writeProjectFile(worktree, "specs/001-demo/extra.md", "extra\n")

    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(true)
    expect(result.safetySnapshotId).toBe(safety.id)
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")
    await expectPathMissing(worktree, "specs/001-demo/extra.md")
    await expectRestoreJournal(worktree, false)
  })

  it("does nothing when there is no journal", async () => {
    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(false)
    expect(result.error).toBeNull()
  })

  it("reports an error and keeps the journal when the safety snapshot is unreadable", async () => {
    await writePendingRestoreJournal(worktree, {
      snapshotId: "20990101-000000-manual",
      safetySnapshotId: "20990101-000000-missing",
    })
    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(false)
    expect(result.error).toContain("unreadable")
    await expectRestoreJournal(worktree, true)
    await clearRestoreJournal(worktree)
  })
})
