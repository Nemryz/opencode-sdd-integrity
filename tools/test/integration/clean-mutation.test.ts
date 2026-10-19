import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import cleanTool from "../../speckit-clean"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, writeSpecJson, readSession, writeSession, specsDirPath, pushCorruptionWarning, clearCorruptionWarnings } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  clearCorruptionWarnings()
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("Phase 7: Clean Module - Mutation Score Improvement", () => {

  describe("7.1 Phase preservation", () => {
    it("does not report mismatch for tasks phase when tasks not approved", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.phase = "tasks"
        sj.approvals.tasks.approved = false
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      const issues: string[] = result.metadata?.issues ?? []
      const specJsonIssues = issues.filter(i => i.includes("spec.json") && i.includes("phase"))
      expect(specJsonIssues).toHaveLength(0)
    })

    it("preserves complete phase when files show ready", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.phase = "complete"
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      const issues: string[] = result.metadata?.issues ?? []
      const specJsonIssues = issues.filter(i => i.includes("spec.json") && i.includes("phase"))
      expect(specJsonIssues).toHaveLength(0)
    })

    it("preserves impl phase when files show ready", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.phase = "impl"
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      const issues: string[] = result.metadata?.issues ?? []
      const specJsonIssues = issues.filter(i => i.includes("spec.json") && i.includes("phase"))
      expect(specJsonIssues).toHaveLength(0)
    })

    it("reports mismatch when phase is genuinely wrong", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.phase = "ready"
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("spec.json"))).toBe(true)
    })

    it("reports mismatch when tasks approved but phase not ready", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.phase = "spec"
        sj.approvals.tasks.approved = true
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("spec.json"))).toBe(true)
    })
  })

  describe("7.2 Session fix", () => {
    it("fixes session phase to match reality", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const result = await cleanTool.execute({ fix: true }, ctx)
      const session = await readSession(worktree)
      expect(session.phase).toBeDefined()
    })

    it("updates session featureDir when current feature no longer exists", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const specsDir = specsDirPath(worktree)
      await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
      const result = await cleanTool.execute({ fix: true }, ctx)
      expect(result.title).toContain("Clean")
    })

    it("assigns session featureDir when null but features exist", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await cleanTool.execute({ fix: true }, ctx)
      const session = await readSession(worktree)
      expect(session.featureDir).toBe("001-auth")
    })

    it("fixes session featureNumber mismatch", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
      const result = await cleanTool.execute({ fix: true }, ctx)
      const session = await readSession(worktree)
      expect(session.featureNumber).toBeDefined()
    })

    it("appends /clean to session history", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      session.phase = "init"
      await writeSession(worktree, session)
      await cleanTool.execute({ fix: true }, ctx)
      const after = await readSession(worktree)
      expect(after.history).toContain("/clean")
    })

    it("truncates session history to 20 entries", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      for (let i = 0; i < 25; i++) {
        await cleanTool.execute({ fix: true }, ctx)
      }
      const session = await readSession(worktree)
      expect(session.history.length).toBeLessThanOrEqual(20)
    })

    it("sets lastResult during fix", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const stale = await readSession(worktree)
      stale.phase = "init"
      await writeSession(worktree, stale)
      await cleanTool.execute({ fix: true }, ctx)
      const session = await readSession(worktree)
      expect(session.lastResult).toContain("repaired")
    })
  })

  describe("7.3 Delta cleanup", () => {
    it("reports cancelled deltas as warnings", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const deltasDir = path.join(base, "deltas")
      await fs.mkdir(deltasDir, { recursive: true })
      await fs.writeFile(path.join(deltasDir, "deltas.json"), JSON.stringify({
        feature: "001-auth",
        deltas: [{
          id: "D001",
          type: "feature",
          title: "Old Delta",
          status: "cancelled",
          impact: "low",
          parent_feature: "001-auth",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }, null, 2))
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("cancelled delta"))).toBe(true)
    })

    it("does not report non-cancelled deltas as warnings", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const deltasDir = path.join(base, "deltas")
      await fs.mkdir(deltasDir, { recursive: true })
      await fs.writeFile(path.join(deltasDir, "deltas.json"), JSON.stringify({
        feature: "001-auth",
        deltas: [{
          id: "D001",
          type: "feature",
          title: "Active Delta",
          status: "draft",
          impact: "low",
          parent_feature: "001-auth",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }, null, 2))
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("cancelled delta"))).toBe(false)
    })

    it("reports count of cancelled deltas", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const deltasDir = path.join(base, "deltas")
      await fs.mkdir(deltasDir, { recursive: true })
      await fs.writeFile(path.join(deltasDir, "deltas.json"), JSON.stringify({
        feature: "001-auth",
        deltas: [
          { id: "D001", type: "feature", title: "A", status: "cancelled", impact: "low", parent_feature: "001-auth", created_at: "", updated_at: "" },
          { id: "D002", type: "feature", title: "B", status: "cancelled", impact: "low", parent_feature: "001-auth", created_at: "", updated_at: "" },
          { id: "D003", type: "feature", title: "C", status: "draft", impact: "low", parent_feature: "001-auth", created_at: "", updated_at: "" },
        ],
      }, null, 2))
      const result = await cleanTool.execute({}, ctx)
      const deltaIssues = (result.metadata?.issues as string[]).filter(i => i.includes("cancelled delta"))
      expect(deltaIssues).toHaveLength(1)
      expect(deltaIssues[0]).toContain("2")
    })
  })

  describe("7.4 Report generation", () => {
    it("returns correct title with feature and issue counts", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await cleanTool.execute({}, ctx)
      expect(result.title).toContain("Clean")
      expect(result.title).toContain("1 features")
    })

    it("returns All features consistent when no issues", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const result = await cleanTool.execute({}, ctx)
      expect(result.output).toContain("All features consistent")
    })

    it("reports issue count in output", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await cleanTool.execute({}, ctx)
      expect(result.output).toContain("issue(s) detected")
    })

    it("includes metadata with ok, incomplete, orphan counts", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.ok).toBe(1)
      expect(result.metadata?.incomplete).toBe(1)
      expect(result.metadata?.total).toBe(2)
    })

    it("includes reports array in metadata", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.reports).toBeDefined()
      expect(Array.isArray(result.metadata?.reports)).toBe(true)
      expect(result.metadata?.reports.length).toBe(1)
    })
  })

  describe("7.5 ready_for_implementation checks", () => {
    it("reports ready_for_implementation mismatch when files not ready", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.ready_for_implementation = true
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("ready_for_implementation"))).toBe(true)
    })

    it("does not report ready_for_implementation when files are ready", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.ready_for_implementation = true
        sj.approvals.tasks.approved = true
        sj.phase = "ready"
        await writeSpecJson(sj, base)
      }
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("ready_for_implementation"))).toBe(false)
    })

    it("fix sets ready_for_implementation correctly when tasks approved", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.ready_for_implementation = false
        sj.approvals.tasks.approved = true
        sj.phase = "ready"
        await writeSpecJson(sj, base)
      }
      await cleanTool.execute({ fix: true }, ctx)
      const fixedSj = await readSpecJson(base)
      expect(fixedSj?.ready_for_implementation).toBe(true)
    })

    it("fix sets ready_for_implementation to false when tasks not approved", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const base = path.join(worktree, "specs", "001-auth")
      const sj = await readSpecJson(base)
      if (sj) {
        sj.ready_for_implementation = true
        sj.approvals.tasks.approved = false
        await writeSpecJson(sj, base)
      }
      await cleanTool.execute({ fix: true }, ctx)
      const fixedSj = await readSpecJson(base)
      expect(fixedSj?.ready_for_implementation).toBe(false)
    })
  })

  describe("7.6 Corruption warnings", () => {
    it("includes corruption warnings in issues", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      clearCorruptionWarnings()
      pushCorruptionWarning(path.join(worktree, "test.json"), "test corruption")
      const result = await cleanTool.execute({}, ctx)
      expect(result.metadata?.issues.some((i: string) => i.includes("[corruption]"))).toBe(true)
    })

    it("does not include corruption warnings after clean", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      clearCorruptionWarnings()
      pushCorruptionWarning(path.join(worktree, "test.json"), "test corruption")
      await cleanTool.execute({}, ctx)
      const result2 = await cleanTool.execute({}, ctx)
      expect(result2.metadata?.issues.some((i: string) => i.includes("test corruption"))).toBe(false)
    })
  })

  describe("7.7 Error handling", () => {
    it("returns error when no worktree", async () => {
      const result = await cleanTool.execute({}, { worktree: undefined } as any)
      expect(result.title).toBe("Error")
    })

    it("returns error when invalid project root", async () => {
      const result = await cleanTool.execute({}, { worktree: "/nonexistent" } as any)
      expect(result.title).toBe("Error")
    })
  })
})
