import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import cleanTool from "../../speckit-clean"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, writeSpecJson, readSession, writeSession, specsDirPath, specJsonPath, clearCorruptionWarnings } from "../../shared/types"

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

describe("Clean kill survivors - phase mismatch guards", () => {
  it("isTasksNotApproved: phase=tasks filesPhase=ready tasks.approved=TRUE reports mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "tasks"
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    const result = await cleanTool.execute({}, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    expect(issues.some(i => i.includes("spec.json") && i.includes("phase"))).toBe(true)
  })

  it("isCompleteNotDowngraded: phase=complete filesPhase=spec reports mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "complete"
      await writeSpecJson(sj, base)
    }
    const result = await cleanTool.execute({}, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    expect(issues.some(i => i.includes("spec.json") && i.includes("phase"))).toBe(true)
  })

  it("isImplNotDowngraded: phase=impl filesPhase=spec reports mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "impl"
      await writeSpecJson(sj, base)
    }
    const result = await cleanTool.execute({}, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    expect(issues.some(i => i.includes("spec.json") && i.includes("phase"))).toBe(true)
  })
})

describe("Clean kill survivors - ready_for_implementation fix", () => {
  it("correctRfi: filesPhase=spec tasks.approved=TRUE rfi=TRUE fix sets rfi=false", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "spec"
      sj.ready_for_implementation = true
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    await cleanTool.execute({ fix: true }, ctx)
    const fixed = await readSpecJson(base)
    expect(fixed?.ready_for_implementation).toBe(false)
  })

  it("correctRfi: filesPhase=ready tasks.approved=FALSE rfi=FALSE fix keeps rfi=false", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      sj.ready_for_implementation = false
      sj.approvals.tasks.approved = false
      await writeSpecJson(sj, base)
    }
    await cleanTool.execute({ fix: true }, ctx)
    const fixed = await readSpecJson(base)
    expect(fixed?.ready_for_implementation).toBe(false)
  })
})

describe("Clean kill survivors - no-change detection", () => {
  it("changed=false: no spec.json mismatch when phase matches filesPhase", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      sj.ready_for_implementation = true
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "ready"
    session.nextStep = "/impl or /review"
    await writeSession(worktree, session)
    const result = await cleanTool.execute({ fix: true }, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    expect(issues.some(i => i.includes("spec.json") && i.includes("phase"))).toBe(false)
    const after = await readSession(worktree)
    expect(after.lastResult).not.toContain("repaired")
  })

  it("changed=false: history not extended when no session changes", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      sj.ready_for_implementation = true
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "ready"
    session.nextStep = "/impl or /review"
    session.history = ["/spec", "/plan", "/tasks"]
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.history).toEqual(["/spec", "/plan", "/tasks"])
  })
})

describe("Clean kill survivors - history truncation", () => {
  it("history exactly 20 entries after fix becomes 21 no truncation", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    session.history = Array(19).fill("/spec")
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.history.length).toBe(20)
  })

  it("history 25 entries after fix truncated to 20", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    session.history = Array(25).fill("/spec")
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.history.length).toBe(20)
  })

  it("slice(-20) keeps last 20 entries not first 20", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    session.history = ["A", "B", "C", ...Array(22).fill("/spec")]
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.history.length).toBe(20)
    expect(after.history[0]).toBe("/spec")
    expect(after.history[after.history.length - 1]).toBe("/clean")
  })
})

describe("Clean kill survivors - output field names", () => {
  it("lastResult contains featureDir field name after fix", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "nonexistent"
    session.featureNumber = 99
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).toContain("featureDir")
  })

  it("lastResult contains featureDir (assigned) when featureDir is null", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = null
    session.featureNumber = null
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).toContain("featureDir (assigned)")
  })

  it("lastResult contains featureNumber field name when mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 99
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).toContain("featureNumber")
  })

  it("lastResult contains session phase field name when mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    session.nextStep = null
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).toContain("session phase")
  })
})

describe("Clean kill survivors - reports.find correctness", () => {
  it("reports.find matches correct dir with multiple features", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.phase).toBe("spec")
  })

  it("reports.find matches correct dir when second feature has mismatch", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "tasks" }, ctx)
    const billingBase = path.join(worktree, "specs", "002-billing")
    const sj = await readSpecJson(billingBase)
    if (sj) {
      sj.phase = "spec"
      await writeSpecJson(sj, billingBase)
    }
    await cleanTool.execute({ fix: true }, ctx)
    const fixed = await readSpecJson(billingBase)
    expect(fixed?.phase).toBe("tasks")
  })
})

describe("Clean kill survivors - reports.some featureDir check", () => {
  it("reports.some finds existing featureDir does not reassign", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.featureDir).toBe("001-auth")
  })

  it("reports.some does not find deleted featureDir reassigns to last", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    await writeSession(worktree, session)
    const specsDir = specsDirPath(worktree)
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.featureDir).toBe("002-billing")
  })
})

describe("Clean kill survivors - sessionChanges.length check", () => {
  it("no session changes lastResult does not contain repaired", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "ready"
    session.nextStep = "/impl or /review"
    await writeSession(worktree, session)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      sj.ready_for_implementation = true
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).not.toContain("repaired")
  })

  it("session changes present lastResult contains repaired", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 1
    session.phase = "init"
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.lastResult).toContain("repaired")
  })
})

describe("Clean kill survivors - multi-feature phase fixes", () => {
  it("fixes phase mismatch independently per feature", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "tasks" }, ctx)
    const authBase = path.join(worktree, "specs", "001-auth")
    const billingBase = path.join(worktree, "specs", "002-billing")
    const authSj = await readSpecJson(authBase)
    if (authSj) {
      authSj.phase = "ready"
      await writeSpecJson(authSj, authBase)
    }
    const billingSj = await readSpecJson(billingBase)
    if (billingSj) {
      billingSj.phase = "spec"
      await writeSpecJson(billingSj, billingBase)
    }
    await cleanTool.execute({ fix: true }, ctx)
    const fixedAuth = await readSpecJson(authBase)
    const fixedBilling = await readSpecJson(billingBase)
    expect(fixedAuth?.phase).toBe("spec")
    expect(fixedBilling?.phase).toBe("tasks")
  })

  it("reports.find with dir filter uses correct report per entry", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "plan" }, ctx)
    const billingBase = path.join(worktree, "specs", "002-billing")
    const sj = await readSpecJson(billingBase)
    if (sj) {
      sj.phase = "spec"
      await writeSpecJson(sj, billingBase)
    }
    const result = await cleanTool.execute({}, ctx)
    const issues: string[] = result.metadata?.issues ?? []
    expect(issues.some(i => i.includes("002-billing") && i.includes("phase"))).toBe(true)
  })
})

describe("Clean kill survivors - else if reports.length branch", () => {
  it("featureDir null with existing reports assigns last feature", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = null
    session.featureNumber = null
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.featureDir).toBe("002-billing")
    expect(after.featureNumber).toBe(2)
  })
})

describe("Clean kill survivors - featureNumber mismatch", () => {
  it("featureNumber mismatch fix corrects to parseNNN of featureDir", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    let session = await readSession(worktree)
    session.featureDir = "001-auth"
    session.featureNumber = 42
    await writeSession(worktree, session)
    await cleanTool.execute({ fix: true }, ctx)
    const after = await readSession(worktree)
    expect(after.featureNumber).toBe(1)
  })
})
