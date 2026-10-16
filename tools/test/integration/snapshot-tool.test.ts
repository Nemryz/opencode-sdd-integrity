import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import snapshotTool from "../../speckit-snapshot"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  expectFileContent,
  tamperSnapshotFile,
  writePendingRestoreJournal,
  writeProjectFile,
} from "../helpers/assertions"

let worktree: string
let ctx: ReturnType<typeof mockContext>

async function run(args: Record<string, unknown> = {}) {
  return snapshotTool.execute(args as never, ctx)
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  await writeProjectFile(
    worktree,
    ".opencode/spec-memory/session.json",
    JSON.stringify({
      command: "/spec",
      phase: "plan",
      featureDir: "001-demo",
      featureNumber: 1,
      featureName: "demo",
      nextStep: "/tasks",
      lastResult: null,
      history: [],
    }),
  )
  await writeProjectFile(worktree, ".opencode/spec-memory/constitution.md", "# Constitution\n")
  await writeProjectFile(worktree, ".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("speckit-snapshot list", () => {
  it("reports NOT READY when there are no snapshots", async () => {
    const result = await run({})
    expect(result.title).toBe("Snapshots: NOT READY")
    expect(result.output).toContain("no snapshots")
  })

  it("reports DEGRADED until a snapshot is drilled, then READY", async () => {
    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string

    const degraded = await run({ subcommand: "list" })
    expect(degraded.title).toBe("Snapshots: DEGRADED")
    expect(degraded.output).toContain("no snapshot has been drilled")

    await run({ subcommand: "drill", id })
    const ready = await run({ subcommand: "list" })
    expect(ready.title).toBe("Snapshots: READY")
  })

  it("reports NOT READY when an interrupted restore is pending", async () => {
    await run({ subcommand: "create" })
    const entries = (await run({ subcommand: "list" })).metadata?.snapshots as Array<{ id: string }>
    await writePendingRestoreJournal(worktree, { snapshotId: entries[0]?.id ?? "x", safetySnapshotId: entries[0]?.id ?? "x" })
    const result = await run({ subcommand: "list" })
    expect(result.title).toBe("Snapshots: NOT READY")
    expect(result.output).toContain("interrupted restore")
  })
})

describe("speckit-snapshot create and verify", () => {
  it("creates a snapshot with the feature and phase from session.json", async () => {
    const result = await run({ subcommand: "create" })
    expect(result.title).toBe("Snapshot Created")
    expect(result.output).toContain("001-demo")
    expect(result.output).toContain("phase: plan")

    const entry = (await run({ subcommand: "list" })).metadata?.snapshots?.[0] as { feature: string; trigger: string }
    expect(entry.feature).toBe("001-demo")
    expect(entry.trigger).toBe("manual")
  })

  it("verifies a snapshot and reports problems after tampering", async () => {
    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string

    const verified = await run({ subcommand: "verify", id })
    expect(verified.title).toBe("Snapshot Verified")

    await tamperSnapshotFile(worktree, id, "specs/001-demo/spec.md")
    const problems = await run({ subcommand: "verify", id })
    expect(problems.title).toBe("Snapshot Problems")
    expect(problems.output).toContain("mismatch")
  })

  it("errors for an unknown snapshot id", async () => {
    const result = await run({ subcommand: "verify", id: "20990101-000000-nope" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("unreadable")
  })
})

describe("speckit-snapshot preview and restore", () => {
  it("previews changes without writing anything", async () => {
    await run({ subcommand: "create" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    const preview = await run({ subcommand: "preview", id: "latest" })
    expect(preview.title).toBe("Restore Preview")
    expect(preview.output).toContain("changed: 1")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Changed\n")
  })

  it("requires confirmation and reports the impact before restoring", async () => {
    await run({ subcommand: "create" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    const pending = await run({ subcommand: "restore", id: "latest" })
    expect(pending.title).toBe("Confirm Restore")
    expect(pending.metadata?.requiresConfirmation).toBe(true)
    expect(pending.output).toContain("Impact:")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Changed\n")
  })

  it("restores with confirmed and takes a safety snapshot", async () => {
    await run({ subcommand: "create" })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Changed\n")

    const result = await run({ subcommand: "restore", id: "latest", confirmed: true })
    expect(result.title).toBe("Restore Complete")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")

    const entries = (await run({ subcommand: "list" })).metadata?.snapshots as Array<{ trigger: string }>
    expect(entries.some((entry) => entry.trigger.startsWith("pre-restore:"))).toBe(true)
  })
})

describe("speckit-snapshot pin, drill, prune, recover", () => {
  it("pins and unpins a snapshot", async () => {
    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string

    const pinned = await run({ subcommand: "pin", id, label: "golden" })
    expect(pinned.title).toBe("Snapshot Pinned")
    const entry = (await run({ subcommand: "list" })).metadata?.snapshots?.[0] as { pinned: boolean; label: string }
    expect(entry.pinned).toBe(true)
    expect(entry.label).toBe("golden")

    expect((await run({ subcommand: "unpin", id })).title).toBe("Snapshot Unpinned")
    expect((await run({ subcommand: "unpin", id })).output).toContain("had no pin")
  })

  it("drills a snapshot and fails the drill after tampering", async () => {
    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string

    expect((await run({ subcommand: "drill", id })).title).toBe("Drill Passed")

    await tamperSnapshotFile(worktree, id, "specs/001-demo/spec.md")
    const failed = await run({ subcommand: "drill", id })
    expect(failed.title).toBe("Drill Failed")
    expect(failed.output).toContain("not safe")
  })

  it("prunes when idle and aborts while a journal is pending", async () => {
    const idle = await run({ subcommand: "prune" })
    expect(idle.title).toBe("Prune Complete")
    expect(idle.output).toContain("removed 0")

    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string
    await writePendingRestoreJournal(worktree, { snapshotId: id, safetySnapshotId: id })
    const aborted = await run({ subcommand: "prune" })
    expect(aborted.title).toBe("Prune Aborted")
    expect(aborted.output).toContain("journal")
  })

  it("recovers an interrupted restore and reports when there is nothing to recover", async () => {
    const created = await run({ subcommand: "create" })
    const id = created.metadata?.snapshotId as string
    await writePendingRestoreJournal(worktree, { snapshotId: "20990101-000000-manual", safetySnapshotId: id })
    await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Half restored\n")

    const recovered = await run({ subcommand: "recover" })
    expect(recovered.title).toBe("Restore Recovered")
    await expectFileContent(worktree, "specs/001-demo/spec.md", "# Spec\n")

    const nothing = await run({ subcommand: "recover" })
    expect(nothing.title).toBe("Nothing to Recover")
  })
})

describe("speckit-snapshot gates and errors", () => {
  it("rejects an unknown subcommand", async () => {
    const result = await run({ subcommand: "bogus" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Unknown subcommand")
  })

  it("gates risky project roots behind confirmed", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "snap-gate-"))
    const sysRoot = path.join(base, "bin")
    await fs.mkdir(path.join(sysRoot, ".opencode", "spec-memory"), { recursive: true })
    try {
      const gated = await snapshotTool.execute({ subcommand: "list" } as never, mockContext(sysRoot))
      expect(gated.title).toBe("Warning")
      expect(gated.metadata?.requiresConfirmation).toBe(true)

      const bypassed = await snapshotTool.execute({ subcommand: "list", confirmed: true } as never, mockContext(sysRoot))
      expect(bypassed.title).toContain("Snapshots:")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
