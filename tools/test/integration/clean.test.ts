import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import cleanTool from "../../speckit-clean"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import validateTool from "../../speckit-validate"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, writeSpecJson, readSession, writeSession, specsDirPath, pushCorruptionWarning, corruptionWarnings, clearCorruptionWarnings } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("clean with no features", () => {
  it("returns No features when specs/ does not exist", async () => {
    const result = await cleanTool.execute({}, ctx)
    expect(result.title).toBe("No features")
  })

  it("returns zero features for empty specs/ directory", async () => {
    const specsDir = specsDirPath(worktree)
    await fs.mkdir(specsDir, { recursive: true })
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.total).toBe(0)
  })

  it("filters out non-NNN directories", async () => {
    const specsDir = specsDirPath(worktree)
    await fs.mkdir(path.join(specsDir, "random-dir"), { recursive: true })
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.total).toBe(0)
    expect(result.metadata?.issues).toHaveLength(0)
  })
})

describe("clean feature status detection", () => {
  it("reports ok for complete feature with tasks not yet approved", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.ok).toBe(1)
    const specJsonIssues = (result.metadata?.issues as string[] ?? []).filter((i: string) => i.includes("spec.json"))
    expect(specJsonIssues).toHaveLength(0)
  })

  it("reports incomplete for spec-only feature", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.incomplete).toBe(1)
    expect(result.metadata?.issues.length).toBeGreaterThanOrEqual(1)
    expect(result.metadata?.issues[0]).toContain("missing")
  })

  it("reports incomplete for spec + plan only", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.incomplete).toBe(1)
  })

  it("reports orphan for empty directory", async () => {
    const specsDir = specsDirPath(worktree)
    await fs.mkdir(path.join(specsDir, "001-empty"), { recursive: true })
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.orphan).toBe(1)
    expect(result.metadata?.issues[0]).toContain("empty")
  })
})

describe("clean spec.json mismatch detection", () => {
  it("detects phase mismatch between spec.json and files", async () => {
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

  it("detects ready_for_implementation mismatch", async () => {
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

  it("reports no spec.json issues when spec.json phase matches reality", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result = await cleanTool.execute({}, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    const specJsonIssues = issues.filter((i: string) => i.includes("spec.json"))
    expect(specJsonIssues).toHaveLength(0)
  })

  it("detects genuine mismatch when phase is wrong for the files present", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "plan"
      await writeSpecJson(sj, base)
    }
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.issues.some((i: string) => i.includes("spec.json"))).toBe(true)
  })

  it("does not downgrade complete phase to ready", async () => {
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
    const specJsonIssues = issues.filter((i: string) => i.includes("spec.json") && i.includes("phase"))
    expect(specJsonIssues).toHaveLength(0)
  })

  it("does not downgrade impl phase to ready", async () => {
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
    const specJsonIssues = issues.filter((i: string) => i.includes("spec.json") && i.includes("phase"))
    expect(specJsonIssues).toHaveLength(0)
  })

  it("does not downgrade session impl phase to ready on fix", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "impl"
    sj.approvals.tasks.approved = true
    sj.ready_for_implementation = true
    await writeSpecJson(sj, base)
    const session = await readSession(worktree)
    session.phase = "impl"
    session.nextStep = "/impl (continue)"
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.phase).toBe("impl")
    expect(after.nextStep).toBe("/impl (continue)")
  })

  it("does not downgrade session complete phase to ready on fix", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "complete"
    sj.approvals.tasks.approved = true
    sj.ready_for_implementation = true
    await writeSpecJson(sj, base)
    const session = await readSession(worktree)
    session.phase = "complete"
    session.nextStep = "/review or start a new feature"
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.phase).toBe("complete")
    expect(after.nextStep).toBe("/review or start a new feature")
  })

  it("keeps session tasks phase until tasks are approved", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const session = await readSession(worktree)
    session.phase = "tasks"
    session.nextStep = "/approve tasks"
    await writeSession(worktree, session)

    await cleanTool.execute({ fix: true }, ctx)
    let after = await readSession(worktree)
    expect(after.phase).toBe("tasks")

    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    await cleanTool.execute({ fix: true }, ctx)
    after = await readSession(worktree)
    expect(after.phase).toBe("ready")
  })
})

describe("clean multiple features", () => {
  it("reports correct counts for mixed features", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const specsDir = specsDirPath(worktree)
    await fs.mkdir(path.join(specsDir, "003-orphan"), { recursive: true })
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.ok).toBe(1)
    expect(result.metadata?.incomplete).toBe(1)
    expect(result.metadata?.orphan).toBe(1)
    expect(result.metadata?.total).toBe(3)
  })
})

describe("clean auto-fix", () => {
  it("fixes spec.json phase mismatch when fix=true", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result1 = await cleanTool.execute({}, ctx)
    expect(result1.metadata?.issues.some((i: string) => i.includes("spec.json"))).toBe(true)
    const result2 = await cleanTool.execute({ fix: true }, ctx)
    const fixedSj = await readSpecJson(base)
    expect(fixedSj?.phase).not.toBe("ready")
    expect(result2.title).toContain("issues")
  })

  it("updates session state during fix", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await cleanTool.execute({ fix: true }, ctx)
    const session = await readSession(worktree)
    expect(session.featureDir).toBe("001-auth")
  })

  it("repairs featureDir in session when previous dir removed", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    await writeSession(worktree, session)
    const specsDir = specsDirPath(worktree)
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    const result = await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureDir).toBeNull()
  })

  it("fixes featureNumber when it does not match the directory number", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 99
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureNumber).toBe(1)
  })

  it("assigns featureDir to latest feature when featureDir is null", async () => {
    await scaffoldTool.execute({ featureName: "A", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "B", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = null
    session.featureNumber = null
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureDir).toBe("002-b")
    expect(session2.featureNumber).toBe(2)
  })

  it("fixes session phase to match spec.json phase when set wrong", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.phase = "init"
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.nextStep = null
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.phase).toBe("spec")
    expect(session2.nextStep).toBe("/approve spec")
  })

  it("realigns a stale session phase with the authoritative spec.json phase", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "impl"
    await writeSpecJson(sj, base)
    // The session lags behind spec.json exactly like a transition interrupted before the session write.
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "ready"
    await writeSession(worktree, session)

    await cleanTool.execute({ fix: true }, ctx)

    const after = await readSession(worktree)
    expect(after.phase).toBe("impl")
    expect(after.nextStep).toBe("/impl (continue)")
  })

  it("keeps a mid-workflow feature free of phase issues", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const specOnly = await cleanTool.execute({}, ctx)
    expect((specOnly.metadata?.issues as string[]).filter(i => i.includes("spec.json"))).toHaveLength(0)

    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const specPlan = await cleanTool.execute({}, ctx)
    expect((specPlan.metadata?.issues as string[]).filter(i => i.includes("spec.json"))).toHaveLength(0)
  })

  it("does not advance the phase past the files when fixing a spec-only feature", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")

    const result = await cleanTool.execute({ fix: true }, ctx)

    expect(((result.metadata?.issues ?? []) as string[]).some(i => i.includes("Fix blocked"))).toBe(false)
    const fixed = (await readSpecJson(base))!
    expect(fixed.phase).toBe("spec")
    // The feature is still awaiting its plan, so validation must not report a phase mismatch.
    const validated = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(validated.metadata?.mismatch).toBe(false)
  })

  it("never promotes a feature to ready while tasks approval is missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "spec"
    await writeSpecJson(sj, base)

    await cleanTool.execute({ fix: true }, ctx)

    const fixed = (await readSpecJson(base))!
    expect(fixed.phase).toBe("tasks")
    expect(fixed.ready_for_implementation).toBe(false)
  })

  it("sets ready_for_implementation correctly when tasks approved and all files exist", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "spec"
    sj.ready_for_implementation = false
    sj.approvals = { spec: { generated: true, approved: true }, plan: { generated: true, approved: true }, tasks: { generated: true, approved: true } }
    await writeSpecJson(sj, base)
    await cleanTool.execute({ fix: true }, ctx)
    const fixed = (await readSpecJson(base))!
    expect(fixed.phase).toBe("ready")
    expect(fixed.ready_for_implementation).toBe(true)
  })

  it("fixes featureDir when deleted but other features remain (T-7)", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    await writeSession(worktree, session)
    const specsDir = specsDirPath(worktree)
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    const result = await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureDir).toBe("002-billing")
    expect(session2.featureNumber).toBe(2)
  })

  it("clears featureDir when specs empty after deleting last feature (T-8)", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    await writeSession(worktree, session)
    const specsDir = specsDirPath(worktree)
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    const result = await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureDir).toBeNull()
    expect(session2.featureNumber).toBeNull()
  })

  it("detects init phase when constitution is missing (F-5)", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const constitutionPath = path.join(worktree, ".opencode", "spec-memory", "constitution.md")
    await fs.rm(constitutionPath, { force: true })
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "ready"
    session.nextStep = "/impl or /review"
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.phase).toBe("init")
    expect(session2.nextStep).toBe("/spec <description>")
  })

  it("fixes multiple session issues in one run", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 77
    session.phase = "init"
    session.nextStep = null
    await writeSession(worktree, session)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.phase = "spec"
    await writeSpecJson(sj, base)
    await cleanTool.execute({ fix: true }, ctx)
    const session2 = await readSession(worktree)
    expect(session2.featureNumber).toBe(1)
    expect(session2.phase).toBe("ready")
    expect(session2.nextStep).toBe("/impl or /review")
    const fixedSj = (await readSpecJson(base))!
    expect(fixedSj.phase).toBe("ready")
  })

  it("includes corruption warnings in issues output", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    clearCorruptionWarnings()
    pushCorruptionWarning(path.join(worktree, "test.json"), "test corruption")
    const result = await cleanTool.execute({}, ctx)
    expect(result.metadata?.issues.some((i: string) => i.includes("[corruption]"))).toBe(true)
    expect(result.metadata?.issues.some((i: string) => i.includes("test.json"))).toBe(true)
    expect(corruptionWarnings.length).toBe(0)
  })
})
