import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { clearRestoreJournal, readRestoreJournal, snapshotsDirPath, writeRestoreJournal } from "../../shared/snapshot/paths"
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

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(worktree, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(worktree, ...rel.split("/")), "utf-8")
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(worktree, ...rel.split("/")))
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  state.failProjectWrites = 0
  worktree = await createTempWorktree()
  await write(
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
  await write(
    ".opencode/spec-memory/config.json",
    JSON.stringify({
      defaultTechStack: null,
      lastUsedLanguage: null,
      expressMode: false,
      autoVersioning: false,
      preferences: {},
    }),
  )
  await write(".opencode/spec-memory/constitution.md", "# Constitution\n")
  await write(".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await write(".opencode/steering/product.md", "# Product\n")
  await write("specs/001-demo/spec.md", "# Spec\n")
  await write("specs/001-demo/plan.md", "# Plan\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("restoreSnapshot confirmation gate", () => {
  it("refuses without confirmed and changes nothing", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")
    const before = await listSnapshots(worktree)

    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: false })).rejects.toThrow(/confirmed/)

    expect(await read("specs/001-demo/spec.md")).toBe("# Changed\n")
    expect(await listSnapshots(worktree)).toEqual(before)
    expect(await readRestoreJournal(worktree)).toBeNull()
  })

  it("refuses when the snapshot fails verification", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.appendFile(path.join(snapshotsDirPath(worktree), manifest.id, "specs", "001-demo", "spec.md"), "x")
    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/verification/)
  })
})

describe("restoreSnapshot full", () => {
  it("restores changed files byte-identical", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")
    await write(".opencode/steering/product.md", "# Other\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(report.restored).toContain("specs/001-demo/spec.md")
    expect(await read("specs/001-demo/spec.md")).toBe("# Spec\n")
    expect(await read(".opencode/steering/product.md")).toBe("# Product\n")
    expect(report.safetySnapshotId).toBeDefined()
  })

  it("re-creates files missing from the current state", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.rm(path.join(worktree, "specs", "001-demo", "plan.md"))
    await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(await read("specs/001-demo/plan.md")).toBe("# Plan\n")
  })

  it("removes extras so the state matches the snapshot exactly (point-in-time)", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/extra.md", "extra\n")
    await write(".opencode/steering/extra.md", "extra\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(report.removed).toContain("specs/001-demo/extra.md")
    expect(await exists("specs/001-demo/extra.md")).toBe(false)
    expect(await exists(".opencode/steering/extra.md")).toBe(false)
    expect(await read("specs/001-demo/spec.md")).toBe("# Spec\n")
  })

  it("takes a pre-restore safety snapshot of the current state", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")

    const report = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    const safety = (await listSnapshots(worktree)).find((s) => s.id === report.safetySnapshotId)
    expect(safety?.trigger).toBe(`pre-restore:${manifest.id}`)

    const safetyCopy = await fs.readFile(
      path.join(snapshotsDirPath(worktree), report.safetySnapshotId, "specs", "001-demo", "spec.md"),
      "utf-8",
    )
    expect(safetyCopy).toBe("# Changed\n")
  })

  it("is idempotent when the state already matches", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    const second = await restoreSnapshot(worktree, manifest.id, { confirmed: true })
    expect(second.removed).toEqual([])
    expect(await read("specs/001-demo/spec.md")).toBe("# Spec\n")
  })
})

describe("restoreSnapshot rollback", () => {
  it("rolls back to the pre-restore state when a write fails mid-apply", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")
    await write("specs/001-demo/extra.md", "extra\n")
    await fs.rm(path.join(worktree, ".opencode", "steering", "product.md"))

    state.failProjectWrites = 1
    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/rolled back/)

    expect(await read("specs/001-demo/spec.md")).toBe("# Changed\n")
    expect(await read("specs/001-demo/extra.md")).toBe("extra\n")
    expect(await exists(".opencode/steering/product.md")).toBe(false)
    expect(await readRestoreJournal(worktree)).toBeNull()
  })
})

describe("restoreSnapshot selective", () => {
  it("restores only the requested files", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")
    await write("specs/001-demo/plan.md", "# Changed Plan\n")

    const report = await restoreSnapshot(worktree, manifest.id, {
      confirmed: true,
      mode: "selective",
      files: ["specs/001-demo/spec.md"],
    })
    expect(report.restored).toEqual(["specs/001-demo/spec.md"])
    expect(await read("specs/001-demo/spec.md")).toBe("# Spec\n")
    expect(await read("specs/001-demo/plan.md")).toBe("# Changed Plan\n")
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
    await write("specs/001-demo/spec.md", "# Changed\n")
    await fs.rm(path.join(worktree, "specs", "001-demo", "plan.md"))
    await write("specs/001-demo/extra.md", "extra\n")

    const before = await listSnapshots(worktree)
    const preview = await previewRestore(worktree, manifest.id)

    expect(preview.entries.find((e) => e.path === "specs/001-demo/spec.md")?.status).toBe("changed")
    expect(preview.entries.find((e) => e.path === "specs/001-demo/plan.md")?.status).toBe("missing")
    expect(preview.entries.find((e) => e.path === ".opencode/guard.json")?.status).toBe("identical")
    expect(preview.extras).toContain("specs/001-demo/extra.md")

    expect(await read("specs/001-demo/spec.md")).toBe("# Changed\n")
    expect(await listSnapshots(worktree)).toEqual(before)
    expect(await readRestoreJournal(worktree)).toBeNull()
  })

  it("limits the preview to the requested files in selective mode", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await write("specs/001-demo/spec.md", "# Changed\n")
    await write("specs/001-demo/plan.md", "# Changed Plan\n")

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
    await writeRestoreJournal(worktree, {
      format: 1,
      snapshot_id: "20990101-000000-manual",
      safety_snapshot_id: safety.id,
      mode: "full",
      started_at: new Date().toISOString(),
      files: [],
      removed: [],
    })
    await write("specs/001-demo/spec.md", "# Half restored\n")
    await write("specs/001-demo/extra.md", "extra\n")

    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(true)
    expect(result.safetySnapshotId).toBe(safety.id)
    expect(await read("specs/001-demo/spec.md")).toBe("# Spec\n")
    expect(await exists("specs/001-demo/extra.md")).toBe(false)
    expect(await readRestoreJournal(worktree)).toBeNull()
  })

  it("does nothing when there is no journal", async () => {
    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(false)
    expect(result.error).toBeNull()
  })

  it("reports an error and keeps the journal when the safety snapshot is unreadable", async () => {
    await writeRestoreJournal(worktree, {
      format: 1,
      snapshot_id: "20990101-000000-manual",
      safety_snapshot_id: "20990101-000000-missing",
      mode: "full",
      started_at: new Date().toISOString(),
      files: [],
      removed: [],
    })
    const result = await recoverInterruptedRestore(worktree)
    expect(result.recovered).toBe(false)
    expect(result.error).toContain("unreadable")
    expect(await readRestoreJournal(worktree)).not.toBeNull()
    await clearRestoreJournal(worktree)
  })
})
