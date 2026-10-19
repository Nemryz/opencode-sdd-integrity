import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import validateTool from "../../speckit-validate"
import statusTool from "../../speckit-status"
import auditTool from "../../speckit-audit"
import cleanTool from "../../speckit-clean"
import phaseTool from "../../speckit-phase"
import evidenceTool from "../../speckit-evidence"
import snapshotTool from "../../speckit-snapshot"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, readSession, specsDirPath, sessionPath } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("full E2E lifecycle: spec, plan, tasks, validate, status, audit", () => {
  it("runs complete spec:plan:tasks lifecycle with phase transitions", async () => {
    const specR = await scaffoldTool.execute({ featureName: "User Auth", template: "spec" }, ctx)
    expect(specR.metadata?.featureDir).toBe("001-user-auth")
    expect(specR.metadata?.phase).toBe("spec")
    expect(specR.metadata?.nextCommand).toContain("/approve spec")

    const specPath = path.join(worktree, "specs", "001-user-auth", "spec.md")
    const specContent = await fs.readFile(specPath, "utf-8")
    expect(specContent).toContain("spec: User Auth")
    expect(specContent).toContain("Content pending skill generation")

    const sj1 = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj1?.phase).toBe("spec")
    expect(sj1?.approvals.spec.generated).toBe(true)
    expect(sj1?.approvals.spec.approved).toBe(false)

    const approveSpec = await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    expect(approveSpec.title).toBe("spec approved")
    expect(approveSpec.metadata?.nextStep).toContain("/plan")
    const sj1b = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj1b?.approvals.spec.approved).toBe(true)

    const planR = await scaffoldTool.execute({ featureName: "User Auth", template: "plan", techStack: "Node.js" }, ctx)
    expect(planR.metadata?.featureDir).toBe("001-user-auth")
    expect(planR.metadata?.phase).toBe("plan")
    expect(planR.metadata?.nextCommand).toContain("/approve plan")

    const planPath = path.join(worktree, "specs", "001-user-auth", "plan.md")
    const planContent = await fs.readFile(planPath, "utf-8")
    expect(planContent).toContain("plan: User Auth")
    expect(planContent).toContain("Content pending skill generation")

    const sj2 = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj2?.phase).toBe("plan")
    expect(sj2?.approvals.spec.approved).toBe(true)
    expect(sj2?.approvals.plan.generated).toBe(true)

    const approvePlan = await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    expect(approvePlan.title).toBe("plan approved")
    const sj2b = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj2b?.approvals.plan.approved).toBe(true)

    const tasksR = await scaffoldTool.execute({ featureName: "User Auth", template: "tasks" }, ctx)
    expect(tasksR.metadata?.featureDir).toBe("001-user-auth")
    expect(tasksR.metadata?.phase).toBe("tasks")
    expect(tasksR.metadata?.nextCommand).toContain("/approve tasks")

    const tasksPath = path.join(worktree, "specs", "001-user-auth", "tasks.md")
    const tasksContent = await fs.readFile(tasksPath, "utf-8")
    expect(tasksContent).toContain("tasks: User Auth")
    expect(tasksContent).toContain("Content pending skill generation")

    const sj3 = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj3?.phase).toBe("tasks")
    expect(sj3?.approvals.plan.approved).toBe(true)
    expect(sj3?.approvals.tasks.generated).toBe(true)

    const approveTasks = await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    expect(approveTasks.title).toBe("tasks approved")
    const sj4 = await readSpecJson(path.join(worktree, "specs", "001-user-auth"))
    expect(sj4?.approvals.tasks.approved).toBe(true)
    expect(sj4?.phase).toBe("ready")
    expect(sj4?.ready_for_implementation).toBe(true)
  })

  it("validate reflects phase after each step", async () => {
    const v0 = await validateTool.execute({}, ctx)
    expect(v0.metadata?.phase).toBe("empty")

    await scaffoldTool.execute({ featureName: "Login", template: "spec" }, ctx)
    const v1 = await validateTool.execute({ featureDir: "001-login" }, ctx)
    expect(v1.metadata?.phase).toBe("spec")
    expect(v1.metadata?.artifacts?.spec).toBe(true)
    expect(v1.metadata?.artifacts?.plan).toBe(false)
    expect(v1.metadata?.nextCommand).toBe("/approve spec")

    await scaffoldTool.execute({ featureName: "Login", template: "plan" }, ctx)
    const v2 = await validateTool.execute({ featureDir: "001-login" }, ctx)
    expect(v2.metadata?.phase).toBe("plan")
    expect(v2.metadata?.artifacts?.spec).toBe(true)
    expect(v2.metadata?.artifacts?.plan).toBe(true)
    expect(v2.metadata?.artifacts?.tasks).toBe(false)

    await scaffoldTool.execute({ featureName: "Login", template: "tasks" }, ctx)
    const v3 = await validateTool.execute({ featureDir: "001-login" }, ctx)
    expect(v3.metadata?.phase).toBe("tasks")
    expect(v3.metadata?.artifacts?.spec).toBe(true)
    expect(v3.metadata?.artifacts?.plan).toBe(true)
    expect(v3.metadata?.artifacts?.tasks).toBe(true)
  })

  it("status reports correct feature count and phases", async () => {
    const s0 = await statusTool.execute({}, ctx)
    expect(s0.metadata?.featureCount).toBe(0)

    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const s1 = await statusTool.execute({}, ctx)
    expect(s1.metadata?.featureCount).toBe(1)
    expect(s1.output).toContain("001-auth")

    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const s2 = await statusTool.execute({}, ctx)
    expect(s2.metadata?.featureCount).toBe(2)
    expect(s2.output).toContain("002-billing")
  })

  it("audit reports no errors after full lifecycle", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const auditR = await auditTool.execute({}, ctx)
    expect(auditR.metadata?.errorCount).toBe(0)
  })

  it("clean reports consistent features after lifecycle", async () => {
    await scaffoldTool.execute({ featureName: "A", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "A", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "B", template: "spec" }, ctx)
    const cleanR = await cleanTool.execute({}, ctx)
    expect(cleanR.metadata?.total).toBe(2)
  })

  it("session.json tracks latest feature after each command", async () => {
    await scaffoldTool.execute({ featureName: "F1", template: "spec" }, ctx)
    let session = await readSession(worktree)
    expect(session.featureDir).toBe("001-f1")
    expect(session.phase).toBe("spec")
    expect(session.command).toBe("/spec")

    await scaffoldTool.execute({ featureName: "F2", template: "spec" }, ctx)
    session = await readSession(worktree)
    expect(session.featureDir).toBe("002-f2")
    expect(session.featureNumber).toBe(2)
    expect(session.history).toContain("/spec")

    await scaffoldTool.execute({ featureName: "F2", template: "plan" }, ctx)
    session = await readSession(worktree)
    expect(session.featureDir).toBe("002-f2")
    expect(session.phase).toBe("plan")
    expect(session.nextStep).toContain("/approve plan")
  })

  it("multiple features with correct numbering", async () => {
    const names = ["Alpha", "Beta", "Gamma", "Delta"]
    for (let i = 0; i < names.length; i++) {
      const r = await scaffoldTool.execute({ featureName: names[i], template: "spec" }, ctx)
      expect(r.metadata?.featureDir).toBe(`${String(i + 1).padStart(3, "0")}-${names[i].toLowerCase()}`)
    }
    const dirs = await fs.readdir(specsDirPath(worktree))
    expect(dirs).toHaveLength(4)
    expect(dirs).toContain("001-alpha")
    expect(dirs).toContain("002-beta")
    expect(dirs).toContain("003-gamma")
    expect(dirs).toContain("004-delta")
  })

  it("overwrites existing plan.md when overwrite:true", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)

    const noOverwrite = await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    expect(noOverwrite.metadata?.featureDir).toBe("001-auth")

    const doublePlan = await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    expect(doublePlan.metadata?.exists).toBe(true)

    const withOverwrite = await scaffoldTool.execute({ featureName: "Auth", template: "plan", overwrite: true }, ctx)
    expect(withOverwrite.metadata?.featureDir).toBe("001-auth")
  })

  it("steering docs work alongside features", async () => {
    const steeringR = await scaffoldTool.execute({ featureName: "MyKit", template: "steering" }, ctx)
    expect(steeringR.metadata?.created).toHaveLength(3)

    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const statusR = await statusTool.execute({}, ctx)
    expect(statusR.metadata?.featureCount).toBe(1)
  })

  it("handles names with special characters and long names", async () => {
    const r1 = await scaffoldTool.execute({ featureName: "User Auth & Profile Management!", template: "spec" }, ctx)
    expect(r1.metadata?.featureDir).toBe("001-user-auth-profile-management")
    expect(r1.metadata?.featureNumber).toBe(1)

    const longName = "a".repeat(100)
    const r2 = await scaffoldTool.execute({ featureName: longName, template: "spec" }, ctx)
    expect(r2.metadata?.truncated).toBe(true)
    expect(r2.metadata?.featureDir!.length).toBeLessThan(90)
  })

  it("records implementation evidence and restores it from a snapshot", async () => {
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)

    const featureDir = path.join(worktree, "specs", "001-auth")
    await fs.writeFile(
      path.join(featureDir, "tasks.md"),
      "# Tasks\n\n### T-001 Add endpoint\n\n### T-002 Add UI\n",
      "utf-8",
    )
    const phase = await phaseTool.execute({ phase: "impl" }, ctx)
    expect(phase.title).not.toBe("Error")

    const evidenceFindings = (result: { metadata?: Record<string, unknown> }) =>
      ((result.metadata?.findings ?? []) as Array<{ category: string }>).filter(finding =>
        finding.category.startsWith("evidence-"),
      )
    expect(evidenceFindings(await auditTool.execute({}, ctx))).toHaveLength(1)

    for (const task of ["T-001", "T-002"]) {
      const recorded = await evidenceTool.execute(
        { command: "record", task, testCommand: "npm test -- --run", exitCode: 0, featureDir: "001-auth" },
        ctx,
      )
      expect(recorded.title).not.toBe("Error")
    }
    expect(evidenceFindings(await auditTool.execute({}, ctx))).toHaveLength(0)

    const status = await evidenceTool.execute({ command: "status" }, ctx)
    expect(status.output).toContain("2/2 tasks covered (2 entries)")

    const snapshot = await snapshotTool.execute({ subcommand: "create", label: "with evidence" }, ctx)
    const snapshotId = snapshot.metadata?.snapshotId as string
    expect(snapshotId).toBeTruthy()

    await evidenceTool.execute(
      { command: "record", task: "T-003", testCommand: "npm test -- --run", featureDir: "001-auth" },
      ctx,
    )
    const restored = await snapshotTool.execute({ subcommand: "restore", id: snapshotId, confirmed: true }, ctx)
    expect(restored.title).toBe("Restore Complete")

    const evidence = JSON.parse(await fs.readFile(path.join(featureDir, "evidence.json"), "utf-8")) as {
      entries: Array<{ task: string }>
    }
    expect(evidence.entries.map(entry => entry.task)).toEqual(["T-001", "T-002"])
  })
})
