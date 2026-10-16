import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { readDrillInfo, readRestoreJournal, snapshotsDirPath, writeRestoreJournal } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots } from "../../shared/snapshot/manifest"
import { recoverInterruptedRestore, restoreSnapshot } from "../../shared/snapshot/restore"
import { drillSnapshot } from "../../shared/snapshot/retention"
import { snapshotBeforeOperation } from "../../shared/snapshot/triggers"
import { writeProjectFile } from "../helpers/assertions"

let worktree: string

// Builds a filesystem error with the code that the injected failure must carry.
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

// Lists the snapshot folders that exist on disk so leftover partial data becomes visible.
async function snapshotFolders(): Promise<string[]> {
  const entries = await fs.readdir(snapshotsDirPath(worktree), { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  await writeProjectFile(worktree, ".opencode/spec-memory/session.json", JSON.stringify({ phase: "spec" }))
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
})

afterEach(async () => {
  vi.restoreAllMocks()
  await destroyTempWorktree(worktree)
})

describe("chaos: snapshot creation", () => {
  it("removes the partial folder when a file copy runs out of space", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(failure("ENOSPC"))

    await expect(createSnapshot(worktree, { trigger: "manual" })).rejects.toThrow()
    expect(await listSnapshots(worktree)).toEqual([])
    expect(await snapshotFolders()).toEqual([])
  })

  it("fails when the snapshots folder cannot be created", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(failure("EACCES"))

    await expect(createSnapshot(worktree, { trigger: "manual" })).rejects.toThrow()
    expect(await listSnapshots(worktree)).toEqual([])
  })

  it("removes the partial folder when the written copy does not match the manifest hash", async () => {
    const originalWrite = fs.writeFile.bind(fs)
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      const asPath = String(target)
      const insideSnapshots = asPath.includes(`${path.sep}snapshots${path.sep}`)
      const payload = insideSnapshots ? `${String(data)}corrupted` : data
      return originalWrite(target as never, payload as never, options as never)
    })

    await expect(createSnapshot(worktree, { trigger: "manual" })).rejects.toThrow(/verification failed/)
    expect(await listSnapshots(worktree)).toEqual([])
    expect(await snapshotFolders()).toEqual([])
  })

  it("reports the failure to the trigger helper so callers can block the operation", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(failure("ENOSPC"))

    const result = await snapshotBeforeOperation(worktree, "pre-fix:chaos")

    expect(result.ok).toBe(false)
    expect(result.snapshotId).toBeNull()
    expect(result.error).toContain("ENOSPC")
    expect(await listSnapshots(worktree)).toEqual([])
  })
})

describe("chaos: snapshot drill", () => {
  it("records the failure in the drill sidecar instead of throwing", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const originalRead = fs.readFile.bind(fs)
    let injected = false
    vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const asPath = String(target)
      const readsDataCopy = asPath.includes(`${path.sep}snapshots${path.sep}`) && !asPath.endsWith("manifest.json")
      if (readsDataCopy && !injected) {
        injected = true
        throw failure("EACCES")
      }
      return originalRead(target as never, options as never)
    })

    const drill = await drillSnapshot(worktree, manifest.id)

    expect(drill.ok).toBe(false)
    expect(drill.error).toContain("EACCES")
    const stored = await readDrillInfo(worktree, manifest.id)
    expect(stored?.ok).toBe(false)
    expect(stored?.error).toContain("EACCES")
  })
})

describe("chaos: restore and recovery", () => {
  it("keeps the journal when the rollback fails and recovers on the next attempt", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    // Writes that land on the project fail while writes inside the snapshots folder succeed,
    // so the safety snapshot is captured and then both the apply and the rollback are refused.
    const originalWrite = fs.writeFile.bind(fs)
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      const asPath = String(target)
      const insideSnapshots = asPath.includes(`${path.sep}snapshots${path.sep}`)
      if (!insideSnapshots) throw failure("EACCES")
      return originalWrite(target as never, data as never, options as never)
    })

    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/rollback/)

    // The journal survives because the rollback could not finish, which is the signal for recovery.
    const journalAfterFailure = await readRestoreJournal(worktree)
    expect(journalAfterFailure).not.toBeNull()

    vi.restoreAllMocks()
    const recovery = await recoverInterruptedRestore(worktree)

    // The safety snapshot holds the state from before the restore started, so recovery
    // returns the file to the edited content instead of the older snapshot content.
    expect(recovery.recovered).toBe(true)
    expect(await readRestoreJournal(worktree)).toBeNull()
    expect(await fs.readFile(path.join(worktree, "specs", "001-demo", "spec.md"), "utf-8")).toBe("# Changed\n")
  })

  it("rolls back and clears the journal when a single apply write fails", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    // Only the first write that lands on the project fails, so the rollback can still finish.
    const originalWrite = fs.writeFile.bind(fs)
    let projectWrites = 0
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      const asPath = String(target)
      const insideSnapshots = asPath.includes(`${path.sep}snapshots${path.sep}`)
      if (!insideSnapshots) {
        projectWrites++
        if (projectWrites === 1) throw failure("ENOSPC")
      }
      return originalWrite(target as never, data as never, options as never)
    })

    await expect(restoreSnapshot(worktree, manifest.id, { confirmed: true })).rejects.toThrow(/rolled back/)
    vi.restoreAllMocks()

    // A rolled back restore leaves no journal behind and puts the pre restore content in place,
    // which is what the safety snapshot captured before the apply started.
    expect(await readRestoreJournal(worktree)).toBeNull()
    expect(await fs.readFile(path.join(worktree, "specs", "001-demo", "spec.md"), "utf-8")).toBe("# Changed\n")
  })

  it("reports an unreadable safety snapshot and keeps the journal for a later attempt", async () => {
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

    // Losing the safety snapshot turns recovery into a reported error instead of a silent success.
    await fs.rm(path.join(snapshotsDirPath(worktree), safety.id), { recursive: true, force: true })

    const recovery = await recoverInterruptedRestore(worktree)

    expect(recovery.recovered).toBe(false)
    expect(recovery.error).toContain("unreadable")
    expect(await readRestoreJournal(worktree)).not.toBeNull()
  })
})