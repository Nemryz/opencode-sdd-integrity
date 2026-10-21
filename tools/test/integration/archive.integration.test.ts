import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import archiveTool, { todayStamp } from "../../speckit-archive"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let ctx: ReturnType<typeof mockContext>

async function run(args: Record<string, unknown> = {}) {
  return archiveTool.execute(args as never, ctx)
}

async function writeSpecJson(wt: string, featureDir: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(wt, "specs", featureDir), { recursive: true })
  await fs.writeFile(path.join(wt, "specs", featureDir, "spec.json"), JSON.stringify(obj), "utf-8")
}

async function readSpecJsonFile(wt: string, dir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(wt, dir, "spec.json"), "utf-8")
  return JSON.parse(raw)
}

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-archive-"))
  ctx = mockContext(worktree)
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("speckit-archive integration (real filesystem)", () => {
  describe("preconditions", () => {
    it("rejects a feature whose phase is not complete", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "impl",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
      })

      const result = await run({ featureDir: "001-demo", confirmed: true })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("not complete")
    })

    it("warns when phase is complete but converged is false", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "complete",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
        converged: false,
      })

      const result = await run({ featureDir: "001-demo", confirmed: true })
      expect(result.title).toBe("Warning")
      expect(result.output).toContain("has not converged")
      expect(result.metadata?.requiresConfirmation).toBe(true)
    })

    it("errors when no spec.json exists", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      const result = await run({ featureDir: "001-demo", confirmed: true })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("No spec.json found")
    })

    it("errors when feature directory does not exist", async () => {
      const result = await run({ featureDir: "999-nope", confirmed: true })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("No spec.json found")
    })
  })

  describe("archive operation", () => {
    it("moves a complete feature to archive/<date>-<featureDir> and sets archived_at", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "plan.md"), "# Plan\n", "utf-8")
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "complete",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
        converged: true,
      })

      const result = await run({ featureDir: "001-demo", confirmed: true })
      expect(result.title).toBe("Archived")
      expect(result.output).toContain("archived to")
      expect(result.metadata?.movedFiles).toContain("spec.md")
      expect(result.metadata?.movedFiles).toContain("plan.md")

      const relArchive = path.relative(worktree, result.metadata?.archivePath as string)
      const archivedSpec = await readSpecJsonFile(worktree, relArchive)
      expect(archivedSpec.archived_at).toBeDefined()
      expect(typeof archivedSpec.archived_at).toBe("string")
    })

    it("removes the original feature directory from specs/", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "complete",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
        converged: true,
      })

      await run({ featureDir: "001-demo", confirmed: true })
      const stillExists = await fs.access(path.join(worktree, "specs", "001-demo"))
        .then(() => true).catch(() => false)
      expect(stillExists).toBe(false)
    })

    it("appends collision counter when archive name already exists", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n", "utf-8")
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "complete",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
        converged: true,
      })

      const stamp = todayStamp()
      await fs.mkdir(path.join(worktree, "archive", `${stamp}-001-demo`), { recursive: true })

      const result = await run({ featureDir: "001-demo", confirmed: true })
      expect(result.metadata?.archivePath).toContain(`${stamp}-001-demo-2`)
    })
  })

  describe("session cleanup", () => {
    it("clears session.featureDir when archiving the active feature", async () => {
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
      await writeSpecJson(worktree, "001-demo", {
        feature_name: "demo",
        feature_number: 1,
        phase: "complete",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        featureDir: "001-demo",
        approvals: { spec: { generated: false, approved: false }, plan: { generated: false, approved: false }, tasks: { generated: false, approved: false } },
        ready_for_implementation: false,
        active_delta: null,
        converged: true,
      })

      await run({ featureDir: "001-demo", confirmed: true })
      const sessionRaw = await fs.readFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), "utf-8")
      const session = JSON.parse(sessionRaw)
      expect(session.featureDir).toBeNull()
    })
  })
})
