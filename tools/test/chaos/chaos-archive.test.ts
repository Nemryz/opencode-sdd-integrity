import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import archiveTool from "../../speckit-archive"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { snapshotsDirPath } from "../../shared/snapshot/paths"

let worktree: string
let ctx: ReturnType<typeof mockContext>

async function run(args: Record<string, unknown> = {}) {
  return archiveTool.execute(args as never, ctx)
}

async function writeSpecJson(wt: string, featureDir: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(wt, "specs", featureDir), { recursive: true })
  await fs.writeFile(path.join(wt, "specs", featureDir, "spec.json"), JSON.stringify(obj), "utf-8")
}

function completeSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feature_name: "demo",
    feature_number: 1,
    phase: "complete",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    featureDir: "001-demo",
    approvals: { spec: { generated: true, approved: true }, plan: { generated: true, approved: true }, tasks: { generated: true, approved: true } },
    ready_for_implementation: true,
    active_delta: null,
    converged: true,
    ...overrides,
  }
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("chaos: archive on a corrupt spec.json", () => {
  it("returns a clean error and leaves the feature in place", async () => {
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), "{not valid json", "utf-8")

    const result = await run({ featureDir: "001-demo", confirmed: true })

    expect(result.title).toBe("Error")
    expect(result.output).toContain("No spec.json found")

    // Nothing moved: the feature directory and its corrupt file are untouched.
    const stillThere = await fs.access(path.join(worktree, "specs", "001-demo")).then(() => true).catch(() => false)
    expect(stillThere).toBe(true)
    const archiveExists = await fs.access(path.join(worktree, "archive")).then(() => true).catch(() => false)
    expect(archiveExists).toBe(false)
  })

  it("resolves the latest feature and still fails cleanly when its spec.json is corrupt", async () => {
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), "truncated", "utf-8")

    const result = await run({ confirmed: true })

    expect(result.title).toBe("Error")
    expect(result.output).toContain("No spec.json found")
  })
})

describe("chaos: interrupted pre-archive snapshot", () => {
  it("blocks the archive and keeps the feature unarchived when the snapshot cannot be created", async () => {
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
    await writeSpecJson(worktree, "001-demo", completeSpec())

    // Turn the snapshots folder into a plain file so createSnapshot fails with a filesystem error.
    const snapDir = snapshotsDirPath(worktree)
    await fs.mkdir(path.dirname(snapDir), { recursive: true })
    await fs.writeFile(snapDir, "blocked", "utf-8")

    const result = await run({ featureDir: "001-demo", confirmed: true })

    expect(result.title).toBe("Error")
    expect(result.output).toContain("BLOCKED")
    expect(result.output).toContain("pre-archive snapshot")

    // The feature never moved because the snapshot gate fired first.
    const stillThere = await fs.access(path.join(worktree, "specs", "001-demo")).then(() => true).catch(() => false)
    expect(stillThere).toBe(true)
    const archiveExists = await fs.access(path.join(worktree, "archive")).then(() => true).catch(() => false)
    expect(archiveExists).toBe(false)
  })
})

describe("chaos: locked session during archive", () => {
  it("recovers from a stale lock left by a dead process and still clears the active feature", async () => {
    await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), JSON.stringify({
      command: "/impl",
      phase: "impl",
      featureDir: "001-demo",
      featureNumber: 1,
      featureName: "demo",
      nextStep: "/archive",
      lastResult: null,
      history: [],
    }), "utf-8")

    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
    await writeSpecJson(worktree, "001-demo", completeSpec())

    // A stale lock from a dead process (old timestamp) must be reclaimed, not block the archive.
    const lockDir = path.join(worktree, ".opencode", "spec-memory", "session.json.lock")
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(path.join(lockDir, "lock.json"), JSON.stringify({
      pid: 999999,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    }), "utf-8")

    const result = await run({ featureDir: "001-demo", confirmed: true })

    expect(result.title).toBe("Archived")
    const sessionRaw = await fs.readFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), "utf-8")
    const session = JSON.parse(sessionRaw)
    expect(session.featureDir).toBeNull()
  })
})

describe("chaos: no-converge plus unresolved clarification", () => {
  it("warns and requires confirmation when the feature never converged, even with clarification markers in the spec", async () => {
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n\n[NEEDS CLARIFICATION] auth flow\n", "utf-8")
    await writeSpecJson(worktree, "001-demo", completeSpec({ converged: false }))

    const warned = await run({ featureDir: "001-demo" })

    expect(warned.title).toBe("Warning")
    expect(warned.output).toContain("has not converged")
    expect(warned.metadata?.requiresConfirmation).toBe(true)

    // Re-running without confirmation stays a warning (idempotent guard).
    const again = await run({ featureDir: "001-demo" })
    expect(again.title).toBe("Warning")

    // Only an explicit confirmation archives it.
    const archived = await run({ featureDir: "001-demo", confirmed: true })
    expect(archived.title).toBe("Archived")
  })

  it("leaves the spec.md clarification marker untouched on disk after archiving", async () => {
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n[NEEDS CLARIFICATION] auth flow\n", "utf-8")
    await writeSpecJson(worktree, "001-demo", completeSpec({ converged: false }))

    const archived = await run({ featureDir: "001-demo", confirmed: true })
    expect(archived.title).toBe("Archived")

    const relArchive = path.relative(worktree, archived.metadata?.archivePath as string)
    const movedSpec = await fs.readFile(path.join(worktree, relArchive, "spec.md"), "utf-8")
    expect(movedSpec).toContain("[NEEDS CLARIFICATION]")
  })
})