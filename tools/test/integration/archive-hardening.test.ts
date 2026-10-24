import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import archiveTool, { todayStamp } from "../../speckit-archive"
import {
  clearCorruptionWarnings,
  corruptionWarnings,
  pushCorruptionWarning,
  sessionPath,
} from "../../shared/types"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let ctx: ReturnType<typeof mockContext>

function completeSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feature_name: "demo",
    feature_number: 1,
    phase: "complete",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    ready_for_implementation: true,
    active_delta: null,
    converged: true,
    ...overrides,
  }
}

async function writeFeature(base: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(base, { recursive: true })
  await fs.writeFile(path.join(base, "spec.json"), JSON.stringify(completeSpec(overrides)), "utf-8")
  await fs.writeFile(path.join(base, "spec.md"), "# Demo\n", "utf-8")
}

async function run(args: Record<string, unknown> = {}) {
  return archiveTool.execute(args as never, ctx)
}

async function pathExists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true).catch(() => false)
}

beforeEach(async () => {
  clearCorruptionWarnings()
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-hardening-"))
  ctx = mockContext(worktree)
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearCorruptionWarnings()
  await destroyTempWorktree(worktree)
})

describe("archive hardening", () => {
  it("pads single digit months and days in the archive stamp", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0))
    expect(todayStamp()).toBe("2026-01-05")
  })

  it("reports an invalid project root instead of throwing", async () => {
    const invalid = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-invalid-"))
    try {
      const result = await archiveTool.execute({ confirmed: true }, mockContext(invalid))
      expect(result).toEqual({
        title: "Error",
        output: "Not a valid project directory. Open opencode inside your project directory (cd <project> && opencode).",
      })
    } finally {
      await fs.rm(invalid, { recursive: true, force: true })
    }
  })

  it("blocks on a project root warning until the caller confirms", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-warning-"))
    const root = path.join(base, "bin")
    const localCtx = mockContext(root)
    await fs.mkdir(path.join(root, ".opencode", "spec-memory"), { recursive: true })
    await writeFeature(path.join(root, "specs", "001-demo"))
    try {
      const warned = await archiveTool.execute({ featureDir: "001-demo" }, localCtx)
      expect(warned.title).toBe("Warning")
      expect(warned.output).toContain("system directory")
      expect(warned.output).toContain("Ask the user to confirm, then re-run with confirmed: true.")
      expect(warned.metadata?.requiresConfirmation).toBe(true)
      expect(warned.metadata?.warnings).toHaveLength(1)

      const archived = await archiveTool.execute({ featureDir: "001-demo", confirmed: true }, localCtx)
      expect(archived.title).toBe("Archived")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it("reports when specs has no numbered feature", async () => {
    await fs.mkdir(path.join(worktree, "specs", "notes"), { recursive: true })
    const result = await run({})
    expect(result).toEqual({ title: "Error", output: "No features found in specs/. Run /spec first." })
  })

  it("ignores non numbered entries when choosing the latest feature", async () => {
    await writeFeature(path.join(worktree, "specs", "002-demo"), { feature_name: "demo", feature_number: 2 })
    await fs.mkdir(path.join(worktree, "specs", "x999-notes"), { recursive: true })
    const result = await run({})
    expect(result.title).toBe("Archived")
    expect(result.metadata?.archivePath).toContain(`${todayStamp()}-002-demo`)
    expect(await pathExists(path.join(worktree, "specs", "002-demo"))).toBe(false)
    expect(await pathExists(path.join(worktree, "specs", "x999-notes"))).toBe(true)
  })

  it("refuses a feature that is already archived", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    await fs.mkdir(path.join(worktree, "archive", "001-demo"), { recursive: true })
    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result).toEqual({ title: "Error", output: "Feature 001-demo is already archived." })
  })

  it("warns about a parent project that has no session", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-parent-"))
    const root = path.join(parent, "child")
    await fs.mkdir(path.join(parent, ".opencode", "spec-memory"), { recursive: true })
    await fs.mkdir(path.join(root, ".opencode", "spec-memory"), { recursive: true })
    await writeFeature(path.join(root, "specs", "001-demo"))
    try {
      const result = await archiveTool.execute({ featureDir: "001-demo", confirmed: true }, mockContext(root))
      expect(result.title).toBe("Warning")
      expect(result.output).toBe(`Parent project detected at ${parent} without session. Do you want to continue?`)
      expect(result.metadata).toEqual({ parentProject: parent, requiresConfirmation: true })
      expect(await pathExists(path.join(root, "specs", "001-demo"))).toBe(true)
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  it("uses the next free suffix after several archive collisions", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    const stamp = todayStamp()
    await fs.mkdir(path.join(worktree, "archive", `${stamp}-001-demo`), { recursive: true })
    await fs.mkdir(path.join(worktree, "archive", `${stamp}-001-demo-2`), { recursive: true })
    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.metadata?.archivePath).toContain(`${stamp}-001-demo-3`)
  })

  it("clears stale corruption warnings and reports the moved files", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    await fs.writeFile(path.join(worktree, "specs", "001-demo", "plan.md"), "# Plan\n", "utf-8")
    pushCorruptionWarning("stale.json", "stale warning")
    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Archived")
    expect(result.output).toContain(`Feature 001-demo archived to ${result.metadata?.archivePath}.`)
    expect(result.output).toContain("Files moved:")
    expect(result.output).toContain("Run /status to see updated state.")
    expect(result.metadata?.movedFiles).toEqual(["plan.md", "spec.json", "spec.json.sha256", "spec.md"])
    expect(corruptionWarnings).toEqual([])
  })

  it("preserves an unrelated active session when archiving another feature", async () => {
    const session = {
      command: "/impl",
      phase: "impl",
      featureDir: "002-other",
      featureNumber: 2,
      featureName: "other",
      nextStep: "/archive",
      lastResult: null,
      history: ["keep-me"],
    }
    await fs.writeFile(sessionPath(worktree), JSON.stringify(session), "utf-8")
    await writeFeature(path.join(worktree, "specs", "001-demo"))

    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Archived")
    const after = JSON.parse(await fs.readFile(sessionPath(worktree), "utf-8"))
    expect(after).toEqual(session)
  })
})
