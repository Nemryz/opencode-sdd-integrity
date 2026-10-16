import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree, mockContext } from "./setup"
import {
  countBackupsFor,
  expectFeatureSpecJson,
  expectFileContent,
  expectFileExists,
  expectPathMissing,
  expectRestoreJournal,
  expectSchemaValid,
  expectSessionState,
  listSnapshotIds,
  listSnapshotTriggers,
  projectPath,
  readProjectFile,
  readProjectJson,
  snapshotDir,
  snapshotFilePath,
  tamperSnapshotFile,
  writePendingRestoreJournal,
  writeProjectFile,
} from "./assertions"
import { createSnapshot, verifySnapshot } from "../../shared/snapshot/manifest"
import { readRestoreJournal, writeRestoreJournal } from "../../shared/snapshot/paths"
import { SessionStateSchema } from "../../shared/types"

let worktree: string

beforeEach(async () => {
  worktree = await createTempWorktree()
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("assertions: path and file helpers", () => {
  it("projectPath joins posix and windows separators", () => {
    expect(projectPath(worktree, "a/b/c.json")).toBe(path.join(worktree, "a", "b", "c.json"))
    expect(projectPath(worktree, "a\\b\\c.json")).toBe(path.join(worktree, "a", "b", "c.json"))
  })

  it("writeProjectFile creates missing parent folders", async () => {
    await writeProjectFile(worktree, "deep/nested/file.txt", "payload")
    expect(await readProjectFile(worktree, "deep/nested/file.txt")).toBe("payload")
  })

  it("readProjectFile reports the relative path when the file is missing", async () => {
    await expect(readProjectFile(worktree, "nope.txt")).rejects.toThrow(/nope\.txt/)
  })

  it("readProjectJson parses content and tolerates a byte order mark", async () => {
    await writeProjectFile(worktree, "data.json", "\uFEFF{\"ok\":true}")
    expect(await readProjectJson(worktree, "data.json")).toEqual({ ok: true })
  })

  it("expectFileExists and expectPathMissing assert presence and absence", async () => {
    await writeProjectFile(worktree, "present.txt", "x")
    await expectFileExists(worktree, "present.txt")
    await expectPathMissing(worktree, "absent.txt")
  })

  it("expectFileExists fails when the path is a directory", async () => {
    const dir = path.join(worktree, "folder")
    await writeProjectFile(worktree, "folder/inner.txt", "x")
    await expect(expectFileExists(worktree, "folder")).rejects.toThrow()
  })

  it("expectFileContent compares bytes stored on disk", async () => {
    await writeProjectFile(worktree, "exact.txt", "line one\nline two\n")
    await expectFileContent(worktree, "exact.txt", "line one\nline two\n")
  })
})

describe("assertions: schema helper", () => {
  it("accepts valid data and rejects invalid data", () => {
    expect(() => expectSchemaValid(SessionStateSchema, {
      command: null,
      phase: "init",
      featureDir: null,
      featureNumber: null,
      featureName: null,
      nextStep: "/spec",
      lastResult: null,
      history: [],
    })).not.toThrow()

    expect(() => expectSchemaValid(SessionStateSchema, { phase: "not-a-phase" })).toThrow()
  })
})

describe("assertions: state assertions on disk", () => {
  it("expectSessionState validates session.json and matches fields", async () => {
    await writeProjectFile(worktree, ".opencode/spec-memory/session.json", JSON.stringify({
      command: "/spec",
      phase: "spec",
      featureDir: "001-demo",
      featureNumber: 1,
      featureName: "demo",
      nextStep: "/approve spec",
      lastResult: null,
      history: [],
    }))

    const session = await expectSessionState(worktree, { phase: "spec", featureDir: "001-demo" })
    expect(session.history.length).toBeGreaterThanOrEqual(0)
  })

  it("expectFeatureSpecJson validates the feature spec.json", async () => {
    await writeProjectFile(worktree, "specs/001-demo/spec.json", JSON.stringify({
      feature_name: "demo",
      feature_number: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      phase: "ready",
      approvals: {
        spec: { generated: true, approved: true },
        plan: { generated: true, approved: true },
        tasks: { generated: true, approved: true },
      },
      ready_for_implementation: true,
    }))

    const specJson = await expectFeatureSpecJson(worktree, "001-demo", { phase: "ready" })
    expect(specJson?.approvals.tasks.approved).toBe(true)
  })

  it("expectFeatureSpecJson fails when the feature has no spec.json", async () => {
    await expect(expectFeatureSpecJson(worktree, "404-missing", {})).rejects.toThrow()
  })
})

describe("assertions: snapshot helpers", () => {
  it("lists ids and triggers newest first", async () => {
    const base = new Date(2026, 1, 1, 10, 0, 0)
    await createSnapshot(worktree, { trigger: "manual", now: base })
    await createSnapshot(worktree, { trigger: "pre-fix:audit", now: new Date(base.getTime() + 60_000) })

    expect((await listSnapshotIds(worktree)).length).toBe(2)
    expect(await listSnapshotTriggers(worktree)).toEqual(["pre-fix:audit", "manual"])
  })

  it("snapshotDir points at the snapshots folder of the worktree", () => {
    expect(snapshotDir(worktree)).toBe(path.join(worktree, ".opencode", "snapshots"))
  })

  it("expectRestoreJournal asserts the presence of an interrupted restore", async () => {
    await expectRestoreJournal(worktree, false)
    await writeRestoreJournal(worktree, {
      format: 1,
      snapshot_id: "a",
      safety_snapshot_id: "b",
      mode: "full",
      started_at: new Date().toISOString(),
      files: [],
      removed: [],
    })
    await expectRestoreJournal(worktree, true)
  })

  it("snapshotFilePath reaches a stored copy through either separator style", () => {
    expect(snapshotFilePath(worktree, "snap-1", "specs/001-demo/spec.md")).toBe(
      path.join(worktree, ".opencode", "snapshots", "snap-1", "specs", "001-demo", "spec.md"),
    )
    expect(snapshotFilePath(worktree, "snap-1", "specs\\001-demo\\spec.md")).toBe(
      snapshotFilePath(worktree, "snap-1", "specs/001-demo/spec.md"),
    )
  })

  it("tamperSnapshotFile changes the stored bytes without touching the project", async () => {
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
    const manifest = await createSnapshot(worktree, { trigger: "manual" })

    await tamperSnapshotFile(worktree, manifest.id, "specs/001-demo/spec.md")

    const stored = snapshotFilePath(worktree, manifest.id, "specs/001-demo/spec.md")
    expect(await fs.readFile(stored, "utf-8")).toBe("# Spec\nx")
    expect(await readProjectFile(worktree, "specs/001-demo/spec.md")).toBe("# Spec\n")
    expect((await verifySnapshot(worktree, manifest.id)).ok).toBe(false)
  })

  it("writePendingRestoreJournal stores a valid journal and clears on request", async () => {
    await writePendingRestoreJournal(worktree, { snapshotId: "target", safetySnapshotId: "safety" })
    const journal = await readRestoreJournal(worktree)
    expect(journal).toMatchObject({
      snapshot_id: "target",
      safety_snapshot_id: "safety",
      mode: "full",
      files: [],
    })

    await writePendingRestoreJournal(worktree, {
      snapshotId: "target",
      safetySnapshotId: "safety",
      mode: "selective",
      files: ["specs/001-demo/spec.md"],
    })
    expect(await readRestoreJournal(worktree)).toMatchObject({
      mode: "selective",
      files: ["specs/001-demo/spec.md"],
    })
  })
})

describe("assertions: backup counting", () => {
  it("counts backups that belong to a file", async () => {
    await writeProjectFile(worktree, ".opencode/guard.json", "{\"version\":1}")
    const { writeWithBackup } = await import("../../shared/io")
    await writeWithBackup(projectPath(worktree, ".opencode/guard.json"), "{\"version\":2}", worktree)
    await writeWithBackup(projectPath(worktree, ".opencode/guard.json"), "{\"version\":3}", worktree)
    expect(await countBackupsFor(worktree, ".opencode/guard.json")).toBe(2)
    expect(await countBackupsFor(worktree, ".opencode/config.json")).toBe(0)
  })
})

describe("assertions: helpers stay usable from a tool context", () => {
  it("reads state produced by a real tool run", async () => {
    const ctx = mockContext(worktree)
    const scaffold = (await import("../../speckit-scaffold")).default
    await scaffold.execute({ featureName: "Verified Demo", template: "spec" }, ctx)

    await expectSessionState(worktree, { featureDir: "001-verified-demo", phase: "spec" })
    await expectFeatureSpecJson(worktree, "001-verified-demo", { phase: "spec" })
    await expectFileExists(worktree, "specs/001-verified-demo/spec.md")
  })
})