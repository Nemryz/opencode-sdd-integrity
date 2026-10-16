import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { collectScope, readDrillInfo, readPinInfo, snapshotsDirPath } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots } from "../../shared/snapshot/manifest"
import { drillSnapshot, pinSnapshot, unpinSnapshot } from "../../shared/snapshot/retention"

let worktree: string

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(worktree, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  await write(".opencode/spec-memory/constitution.md", "# Constitution\n")
  await write(".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await write("specs/001-demo/spec.md", "# Spec\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("pin/unpin", () => {
  it("pins a snapshot with a label and list reports it", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const pin = await pinSnapshot(worktree, manifest.id, "golden")
    expect(pin.label).toBe("golden")
    expect(await readPinInfo(worktree, manifest.id)).toMatchObject({ label: "golden" })

    const entry = (await listSnapshots(worktree)).find((e) => e.id === manifest.id)
    expect(entry?.pinned).toBe(true)
    expect(entry?.label).toBe("golden")
  })

  it("unpins and reports whether a pin existed", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await pinSnapshot(worktree, manifest.id)
    expect(await unpinSnapshot(worktree, manifest.id)).toBe(true)
    expect(await unpinSnapshot(worktree, manifest.id)).toBe(false)
    expect(await readPinInfo(worktree, manifest.id)).toBeNull()
  })

  it("refuses to pin an unknown snapshot", async () => {
    await expect(pinSnapshot(worktree, "20990101-000000-nope")).rejects.toThrow(/unreadable/)
  })
})

describe("drillSnapshot", () => {
  it("passes on an intact snapshot, records the result, and leaves the project untouched", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const before = await collectScope(worktree)

    const drill = await drillSnapshot(worktree, manifest.id)

    expect(drill.ok).toBe(true)
    expect(drill.files_checked).toBe(manifest.files.length)
    expect(drill.error).toBeNull()
    expect(await readDrillInfo(worktree, manifest.id)).toMatchObject({ ok: true })
    expect(await collectScope(worktree)).toEqual(before)
    expect((await listSnapshots(worktree)).find((e) => e.id === manifest.id)?.drill).toBe("ok")
  })

  it("fails when a snapshot file was modified", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.appendFile(path.join(snapshotsDirPath(worktree), manifest.id, "specs", "001-demo", "spec.md"), "x")

    const drill = await drillSnapshot(worktree, manifest.id)

    expect(drill.ok).toBe(false)
    expect(drill.error).toContain("checksum mismatch")
    expect((await listSnapshots(worktree)).find((e) => e.id === manifest.id)?.drill).toBe("failed")
  })

  it("cleans up its sandbox", async () => {
    // Counts drill sandboxes inside an isolated temp root so drills running in parallel test files cannot shift the count.
    const previousEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-drill-count-"))
    process.env.TMPDIR = isolatedRoot
    process.env.TMP = isolatedRoot
    process.env.TEMP = isolatedRoot

    try {
      const manifest = await createSnapshot(worktree, { trigger: "manual" })
      const countBefore = (await fs.readdir(isolatedRoot)).filter((n) => n.startsWith("sdd-drill-")).length

      await drillSnapshot(worktree, manifest.id)

      const countAfter = (await fs.readdir(isolatedRoot)).filter((n) => n.startsWith("sdd-drill-")).length
      expect(countAfter).toBe(countBefore)
      expect((await fs.readdir(isolatedRoot)).filter((n) => n.startsWith("sdd-drill-"))).toHaveLength(0)
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(isolatedRoot, { recursive: true, force: true })
    }
  })

  it("throws for an unreadable snapshot", async () => {
    await expect(drillSnapshot(worktree, "20990101-000000-nope")).rejects.toThrow(/unreadable/)
  })
})
