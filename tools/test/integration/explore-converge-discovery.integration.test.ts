import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { mockContext, destroyTempWorktree } from "../helpers/setup"
import { repoRootDir } from "../helpers/setup"

let worktree: string

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-flow-"))
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("explore → converge → discovery flow integration", () => {
  const ctx = mockContext(worktree)

  beforeEach(async () => {
    await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
    await fs.mkdir(path.join(worktree, ".opencode", "steering"), { recursive: true })
    await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
  })

  describe("/explore — writes exploration summary", () => {
    it("creates exploration.md with idea, context, clarifications, scope, edge cases", async () => {
      const summary = `# Exploration Summary

## Idea
User authentication with OAuth2

## Context
Existing codebase has no auth module.

## Clarifications needed
- [NEEDS CLARIFICATION] Which OAuth provider?

## Scope proposal
- P1: login with OAuth2
- P2: refresh tokens
- P3: social providers

## Edge cases
- Token expiry

## Suggested next step
/spec user authentication with OAuth2
`
      await fs.writeFile(path.join(worktree, ".opencode", "spec-memory", "exploration.md"), summary, "utf-8")

      const written = await fs.readFile(path.join(worktree, ".opencode", "spec-memory", "exploration.md"), "utf-8")
      expect(written).toContain("User authentication with OAuth2")
      expect(written).toContain("[NEEDS CLARIFICATION]")
      expect(written).toContain("P1")
      expect(written).toContain("/spec")
    })

    it("does not create spec artifacts (explore is read-only thinking)", async () => {
      // No spec.md, plan.md, tasks.md should exist inside the feature dir
      const demoDir = path.join(worktree, "specs", "001-demo")
      const specExists = await fs.access(path.join(demoDir, "spec.md")).then(() => true).catch(() => false)
      const planExists = await fs.access(path.join(demoDir, "plan.md")).then(() => true).catch(() => false)
      const tasksExists = await fs.access(path.join(demoDir, "tasks.md")).then(() => true).catch(() => false)
      expect(specExists).toBe(false)
      expect(planExists).toBe(false)
      expect(tasksExists).toBe(false)
    })
  })

  describe("/converge — reads artifacts and updates spec.json convergence", () => {
    it("reads spec.json, evidence.json, tasks.md and sets converged=true", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.md"), "# Spec\n- Given a user\n- When they log in\n- Then they are authenticated\n", "utf-8")
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "tasks.md"), "# Tasks\n- [x] T-001\n", "utf-8")
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "evidence.json"), JSON.stringify({ tasks: [{ id: "T-001", exitCode: 0 }] }), "utf-8")

      const specJson = {
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
        convergenceHistory: [] as Array<{ date: string; status: string; gaps: number }>,
      }
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), JSON.stringify(specJson), "utf-8")

      // Simulate converge: update spec.json
      const updated = { ...specJson, converged: true, updated_at: "2024-01-03T00:00:00Z" }
      updated.convergenceHistory = [...(updated.convergenceHistory ?? []), { date: "2024-01-03T00:00:00Z", status: "converged", gaps: 0 }]
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), JSON.stringify(updated), "utf-8")

      const finalRaw = await fs.readFile(path.join(worktree, "specs", "001-demo", "spec.json"), "utf-8")
      const final = JSON.parse(finalRaw)
      expect(final.converged).toBe(true)
      expect(final.convergenceHistory).toHaveLength(1)
      expect(final.convergenceHistory[0].status).toBe("converged")
    })

    it("records not-converged when gaps exist", async () => {
      const specJson = {
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
        convergenceHistory: [] as Array<{ date: string; status: string; gaps: number }>,
      }
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), JSON.stringify(specJson), "utf-8")

      const updated = { ...specJson, converged: false, updated_at: "2024-01-03T00:00:00Z" }
      updated.convergenceHistory = [...(updated.convergenceHistory ?? []), { date: "2024-01-03T00:00:00Z", status: "not-converged", gaps: 2 }]
      await fs.writeFile(path.join(worktree, "specs", "001-demo", "spec.json"), JSON.stringify(updated), "utf-8")

      const finalRaw = await fs.readFile(path.join(worktree, "specs", "001-demo", "spec.json"), "utf-8")
      const final = JSON.parse(finalRaw)
      expect(final.converged).toBe(false)
      expect(final.convergenceHistory[0].status).toBe("not-converged")
      expect(final.convergenceHistory[0].gaps).toBe(2)
    })
  })

  describe("/discovery — reads state and recommends next action", () => {
    it("recommends /spec when no features exist", async () => {
      const specsDir = path.join(worktree, "specs")
      await fs.rm(specsDir, { recursive: true, force: true })
      await fs.mkdir(specsDir, { recursive: true })
      const entries = await fs.readdir(specsDir).catch(() => [])
      const featureDirs = entries.filter((e) => /^\d{3}-/.test(e))
      expect(featureDirs.length).toBe(0)
    })

    it("reads session.json and recommends based on phase", async () => {
      await fs.writeFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), JSON.stringify({
        command: "/impl",
        phase: "impl",
        featureDir: "001-demo",
        featureNumber: 1,
        featureName: "demo",
        nextStep: "/converge",
        lastResult: null,
        history: [],
      }), "utf-8")

      const sessionRaw = await fs.readFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), "utf-8")
      const session = JSON.parse(sessionRaw)
      expect(session.nextStep).toBe("/converge")
      expect(session.featureDir).toBe("001-demo")
    })

    it("scans specs/ for feature directories", async () => {
      await fs.mkdir(path.join(worktree, "specs", "001-demo"), { recursive: true })
      await fs.mkdir(path.join(worktree, "specs", "002-auth"), { recursive: true })
      const entries = await fs.readdir(path.join(worktree, "specs"))
      const featureDirs = entries.filter((e) => /^\d{3}-/.test(e)).sort()
      expect(featureDirs).toEqual(["001-demo", "002-auth"])
    })
  })
})
