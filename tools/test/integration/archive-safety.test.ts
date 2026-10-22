import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import archiveTool, { todayStamp } from "../../speckit-archive"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let outside: string
let ctx: ReturnType<typeof mockContext>

function completeSpec(): Record<string, unknown> {
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
  }
}

async function writeFeature(base: string): Promise<void> {
  await fs.mkdir(base, { recursive: true })
  await fs.writeFile(path.join(base, "spec.json"), JSON.stringify(completeSpec()), "utf-8")
  await fs.writeFile(path.join(base, "spec.md"), "# Demo\n", "utf-8")
}

async function run(args: Record<string, unknown> = {}) {
  return archiveTool.execute(args as never, ctx)
}

async function pathExists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true).catch(() => false)
}

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-safety-"))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-outside-"))
  ctx = mockContext(worktree)
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await destroyTempWorktree(worktree)
  await fs.rm(outside, { recursive: true, force: true })
})

describe("archive safety", () => {
  it("rejects a featureDir that tries to escape specs/", async () => {
    const result = await run({ featureDir: "../escape", confirmed: true })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Invalid feature directory name")
  })

  it.skipIf(process.platform === "win32")("rejects a symlinked source directory", async () => {
    await writeFeature(outside)
    await fs.mkdir(path.join(worktree, "specs"), { recursive: true })
    await fs.symlink(outside, path.join(worktree, "specs", "001-demo"), "dir")

    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("unsafe state path")
    expect(await pathExists(path.join(worktree, "specs", "001-demo"))).toBe(true)
    expect(await pathExists(path.join(worktree, "archive"))).toBe(false)
  })

  it.skipIf(process.platform === "win32")("rejects a symlinked archive directory", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    await fs.symlink(outside, path.join(worktree, "archive"), "dir")

    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("unsafe state path")
    expect(await pathExists(path.join(worktree, "specs", "001-demo"))).toBe(true)
    expect(await pathExists(path.join(outside, `${todayStamp()}-001-demo`))).toBe(false)
  })

  it("rebuilds once with the next suffix when the target appears after planning", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    const target = path.join(worktree, "archive", `${todayStamp()}-001-demo`)
    const originalAccess = fs.access.bind(fs)
    let targetChecks = 0
    vi.spyOn(fs, "access").mockImplementation(async (candidate, mode) => {
      if (path.resolve(String(candidate)) === path.resolve(target)) {
        targetChecks++
        if (targetChecks >= 2) return
      }
      return originalAccess(candidate, mode)
    })

    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Archived")
    expect(result.metadata?.archivePath).toContain(`${todayStamp()}-001-demo-2`)
    expect(await pathExists(path.join(worktree, "specs", "001-demo"))).toBe(false)
  })

  it("serializes two archive calls for the same feature", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))

    const results = await Promise.all([
      run({ featureDir: "001-demo", confirmed: true }),
      run({ featureDir: "001-demo", confirmed: true }),
    ])
    expect(results.filter((result) => result.title === "Archived")).toHaveLength(1)
    expect(await pathExists(path.join(worktree, "specs", "001-demo"))).toBe(false)
    const archived = await fs.readdir(path.join(worktree, "archive"))
    expect(archived).toHaveLength(1)
    const transactions = await fs.readdir(path.join(worktree, ".opencode", "transactions")).catch(() => [])
    expect(transactions).toEqual([])
  })

  it("keeps the feature in specs/ when the directory rename fails with EXDEV", async () => {
    await writeFeature(path.join(worktree, "specs", "001-demo"))
    const originalRename = fs.rename.bind(fs)
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === "001-demo" && path.basename(path.dirname(String(to))) === "archive") {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
      }
      return originalRename(from, to)
    })

    const result = await run({ featureDir: "001-demo", confirmed: true })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Archive failed")
    expect(await pathExists(path.join(worktree, "specs", "001-demo", "spec.json"))).toBe(true)
    expect(await pathExists(path.join(worktree, "archive", `${todayStamp()}-001-demo`))).toBe(false)
    const transactions = await fs.readdir(path.join(worktree, ".opencode", "transactions")).catch(() => [])
    expect(transactions).toEqual([])
  })
})
