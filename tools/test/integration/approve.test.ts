import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import approveTool from "../../speckit-approve"
import scaffoldTool from "../../speckit-scaffold"
import phaseTool from "../../speckit-phase"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { readSession, readSpecJson, writeSpecJson, specsDirPath, specJsonPath } from "../../shared/types"
import { readFrontmatter } from "../../shared/io"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

async function featureDirOf(name = "001-test-feature"): Promise<string> {
  return path.join(specsDirPath(worktree), name)
}

describe("approve tool", () => {
  it("approves a generated spec", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    expect(result.title).toBe("spec approved")
    expect(result.metadata?.nextStep).toContain("/plan")

    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.spec.approved).toBe(true)
    expect(sj?.approvals.plan.approved).toBe(false)
  })

  it("requires confirmed before approving", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await approveTool.execute({ artifact: "spec" }, ctx)
    expect(result.title).toBe("Confirm Approval")
    expect(result.metadata?.requiresConfirmation).toBe(true)
    expect(result.metadata?.artifact).toBe("spec")

    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.spec.approved).toBe(false)
  })

  it("records an approval hash and timestamp", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.spec.hash).toBeDefined()
    expect(sj?.approvals.spec.approved_at).toBeDefined()
  })

  it("re-approves when content changed after approval", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const before = (await readSpecJson(await featureDirOf()))?.approvals.spec.hash
    const specPath = path.join(await featureDirOf(), "spec.md")
    await fs.appendFile(specPath, "\n## Extra section\n", "utf-8")

    const pending = await approveTool.execute({ artifact: "spec" }, ctx)
    expect(pending.title).toBe("Confirm Re-Approval")
    expect(pending.metadata?.requiresConfirmation).toBe(true)

    const result = await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    expect(result.title).toBe("spec re-approved")
    expect(result.metadata?.reapproved).toBe(true)

    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.spec.approved).toBe(true)
    expect(sj?.approvals.spec.hash).not.toBe(before)
  })

  it("records a hash for legacy approvals without one", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const featureDir = await featureDirOf()
    const sj = await readSpecJson(featureDir)
    if (sj) {
      sj.approvals.spec.approved = true
      await writeSpecJson(sj, featureDir)
    }
    const result = await approveTool.execute({ artifact: "spec" }, ctx)
    expect(result.title).toBe("spec already approved")
    const after = await readSpecJson(featureDir)
    expect(after?.approvals.spec.hash).toBeDefined()
  })

  it("updates spec.md frontmatter status to approved", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const fm = await readFrontmatter(path.join(await featureDirOf(), "spec.md"))
    expect(fm?.status).toBe("approved")
  })

  it("records the approval in session state", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const session = await readSession(worktree)
    expect(session.command).toBe("/approve")
    expect(session.nextStep).toContain("/plan")
    expect(session.history).toContain("/approve spec")
  })

  it("approves plan after spec", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    const result = await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    expect(result.title).toBe("plan approved")
    expect(result.metadata?.nextStep).toContain("/tasks")

    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.plan.approved).toBe(true)
  })

  it("approving tasks sets phase ready", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "tasks" }, ctx)
    const result = await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    expect(result.title).toBe("tasks approved")

    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.tasks.approved).toBe(true)
    expect(sj?.phase).toBe("ready")
    expect(sj?.ready_for_implementation).toBe(true)
  })

  it("reports already approved without changing anything", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const sjBefore = await readSpecJson(await featureDirOf())
    const result = await approveTool.execute({ artifact: "spec" }, ctx)
    expect(result.title).toBe("spec already approved")
    const sjAfter = await readSpecJson(await featureDirOf())
    expect(sjAfter).toEqual(sjBefore)
  })

  it("lists pending approvals without an artifact argument", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await approveTool.execute({}, ctx)
    expect(result.title).toBe("Approval pending: spec")
    expect(result.output).toContain("spec: pending")
    expect(result.output).toContain("plan: not generated")
    expect(result.output).toContain("tasks: not generated")
    expect(result.output).toContain("Next: /approve spec")
    expect(result.metadata?.pending).toBe("spec")
  })

  it("moves the pending hint to plan after spec is approved", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const result = await approveTool.execute({}, ctx)
    expect(result.title).toBe("Approval pending: plan")
    expect(result.output).toContain("spec: approved")
    expect(result.output).toContain("plan: pending")
    expect(result.output).toContain("Next: /approve plan")
  })

  it("reports fully approved status without a pending hint", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    const result = await approveTool.execute({}, ctx)
    expect(result.title).toBe("Approval status")
    expect(result.output).toContain("spec: approved")
    expect(result.output).toContain("plan: approved")
    expect(result.output).toContain("tasks: approved")
    expect(result.output).not.toContain("Next:")
  })

  it("errors when no feature exists and no artifact argument", async () => {
    const result = await approveTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("No feature found")
  })

  it("errors when the artifact file does not exist", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await approveTool.execute({ artifact: "plan" }, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("plan.md does not exist")
  })

  it("errors when no feature exists", async () => {
    const result = await approveTool.execute({ artifact: "spec" }, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("No feature found")
  })

  it("errors on invalid project root", async () => {
    const badCtx = mockContext(path.join(worktree, "nope"))
    const result = await approveTool.execute({ artifact: "spec" }, badCtx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("does not modify artifact content", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const specPath = path.join(await featureDirOf(), "spec.md")
    const before = await fs.readFile(specPath, "utf-8")
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const after = await fs.readFile(specPath, "utf-8")
    const stripFm = (s: string) => s.split("---").slice(2).join("---")
    expect(stripFm(after)).toBe(stripFm(before))
  })

  it("uses session.featureDir when multiple features exist", async () => {
    await scaffoldTool.execute({ featureName: "First", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Second", template: "spec" }, ctx)
    const result = await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    expect(result.metadata?.featureDir).toBe("002-second")

    const second = await readSpecJson(await featureDirOf("002-second"))
    const first = await readSpecJson(await featureDirOf("001-first"))
    expect(second?.approvals.spec.approved).toBe(true)
    expect(first?.approvals.spec.approved).toBe(false)
  })

  it("writes a schema-valid spec.json", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const raw = JSON.parse(await fs.readFile(specJsonPath(await featureDirOf()), "utf-8"))
    expect(raw.approvals.spec.approved).toBe(true)
    expect(raw.updated_at).toBeDefined()
  })
})

// The command layer enforces the spec to plan to tasks order, while the tool itself holds no such rule.
describe("approve order pinning", () => {
  it("approves a plan while the spec approval is still pending", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)

    const result = await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)

    expect(result.title).toBe("plan approved")
    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.approvals.plan.approved).toBe(true)
    expect(sj?.approvals.spec.approved).toBe(false)
    expect(sj?.phase).toBe("plan")
  })

  it("marks the feature ready when only tasks are approved", async () => {
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "tasks" }, ctx)

    const result = await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)

    expect(result.title).toBe("tasks approved")
    const sj = await readSpecJson(await featureDirOf())
    expect(sj?.phase).toBe("ready")
    expect(sj?.ready_for_implementation).toBe(true)
    expect(sj?.approvals.spec.approved).toBe(false)
    expect(sj?.approvals.plan.approved).toBe(false)

    // The phase tool gates only on the tasks approval, so this sharp edge stays pinned until the command gates run.
    const advanced = await phaseTool.execute({ phase: "impl" }, ctx)
    expect(advanced.title).toBe("Phase: impl")
    expect((await readSpecJson(await featureDirOf()))?.phase).toBe("impl")
  })
})
