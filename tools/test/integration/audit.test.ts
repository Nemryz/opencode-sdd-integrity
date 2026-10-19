import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import auditTool, { AuditFinding } from "../../speckit-audit"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, writeSpecJson, steeringDirPath, PATHS } from "../../shared/types"
import { computeBodyChecksum } from "../../shared/io"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("audit project-level findings", () => {
  it("reports warn when constitution missing", async () => {
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const constitutionFindings = findings.filter((f: AuditFinding) => f.category === "constitution")
    expect(constitutionFindings).toHaveLength(1)
    expect(constitutionFindings[0].severity).toBe("warn")
  })

  it("reports info when constitution present", async () => {
    await createConstitution(worktree)
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const constitutionFindings = findings.filter((f: AuditFinding) => f.category === "constitution")
    expect(constitutionFindings).toHaveLength(1)
    expect(constitutionFindings[0].severity).toBe("info")
  })

  it("reports info when steering directory absent", async () => {
    await createConstitution(worktree)
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const steeringFindings = findings.filter((f: AuditFinding) => f.category === "steering")
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("No steering directory"))).toBe(true)
  })

  it("reports warn when steering directory empty", async () => {
    await createConstitution(worktree)
    const steeringDir = steeringDirPath(worktree)
    await fs.mkdir(steeringDir, { recursive: true })
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const steeringFindings = findings.filter((f: AuditFinding) => f.category === "steering")
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("empty"))).toBe(true)
  })

  it("reports info for full steering context", async () => {
    await createConstitution(worktree)
    const steeringDir = steeringDirPath(worktree)
    await fs.mkdir(steeringDir, { recursive: true })
    await fs.writeFile(path.join(steeringDir, PATHS.PRODUCT_STEERING_FILE), "product")
    await fs.writeFile(path.join(steeringDir, PATHS.TECH_STEERING_FILE), "tech")
    await fs.writeFile(path.join(steeringDir, PATHS.STRUCTURE_STEERING_FILE), "structure")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const fullSteering = findings.filter((f: AuditFinding) => f.category === "steering" && f.message.includes("Full steering"))
    expect(fullSteering).toHaveLength(1)
  })

  it("reports info when only product.md exists", async () => {
    await createConstitution(worktree)
    const steeringDir = steeringDirPath(worktree)
    await fs.mkdir(steeringDir, { recursive: true })
    await fs.writeFile(path.join(steeringDir, PATHS.PRODUCT_STEERING_FILE), "product")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const steeringFindings = findings.filter((f: AuditFinding) => f.category === "steering")
    expect(steeringFindings).toHaveLength(2)
    expect(steeringFindings.every((f: AuditFinding) => f.severity === "info")).toBe(true)
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("missing tech.md"))).toBe(true)
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("missing structure.md"))).toBe(true)
  })

  it("reports info when only tech.md exists", async () => {
    await createConstitution(worktree)
    const steeringDir = steeringDirPath(worktree)
    await fs.mkdir(steeringDir, { recursive: true })
    await fs.writeFile(path.join(steeringDir, PATHS.TECH_STEERING_FILE), "tech")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const steeringFindings = findings.filter((f: AuditFinding) => f.category === "steering")
    expect(steeringFindings).toHaveLength(2)
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("missing product.md"))).toBe(true)
    expect(steeringFindings.some((f: AuditFinding) => f.message.includes("missing structure.md"))).toBe(true)
  })

  it("reports info when two of three steering files exist", async () => {
    await createConstitution(worktree)
    const steeringDir = steeringDirPath(worktree)
    await fs.mkdir(steeringDir, { recursive: true })
    await fs.writeFile(path.join(steeringDir, PATHS.PRODUCT_STEERING_FILE), "product")
    await fs.writeFile(path.join(steeringDir, PATHS.TECH_STEERING_FILE), "tech")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const steeringFindings = findings.filter((f: AuditFinding) => f.category === "steering")
    expect(steeringFindings).toHaveLength(1)
    expect(steeringFindings[0].severity).toBe("info")
    expect(steeringFindings[0].message).toContain("missing structure.md")
  })

  it("reports info when no features exist", async () => {
    await createConstitution(worktree)
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "features" && f.message.includes("No feature"))).toBe(true)
  })

  it("reports info with feature count", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "features" && f.message.includes("2 feature"))).toBe(true)
  })
})

describe("audit per-feature findings", () => {
  it("reports warn when spec.json missing", async () => {
    await createConstitution(worktree)
    await fs.mkdir(path.join(worktree, "specs", "001-auth"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-auth", "spec.md"), "# Auth")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "spec-json" && f.severity === "warn")).toBe(true)
  })

  it("reports error on phase mismatch: ready but files missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "phase-mismatch" && f.severity === "error")).toBe(true)
  })

  it("reports error on phase mismatch: spec.json says spec but spec.md missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    await fs.rm(path.join(base, "spec.md"))
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "spec"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "phase-mismatch")).toBe(true)
  })

  it("reports error on phase mismatch: spec.json says plan but plan.md missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "plan"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "phase-mismatch")).toBe(true)
  })

  it("reports error on phase mismatch: spec.json says tasks but tasks.md missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "tasks"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "phase-mismatch")).toBe(true)
  })

  it("skips phase mismatch check for impl and complete phases", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "complete"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "phase-mismatch")).toBe(false)
  })

  it("reports info when approval not marked generated", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.approvals.spec.generated = false
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    const approvalFindings = findings.filter((f: AuditFinding) => f.category === "approval")
    expect(approvalFindings.length).toBeGreaterThanOrEqual(1)
    expect(approvalFindings.every((f: AuditFinding) => f.severity === "info")).toBe(true)
  })

  it("reports warn when spec approved but plan not generated", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.approvals.spec.approved = true
      sj.approvals.plan.generated = false
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "approval-order" && f.severity === "warn")).toBe(true)
  })

  it("reports warn when an approved artifact changed after approval", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.approvals.spec.approved = true
      sj.approvals.spec.hash = "deadbeef"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "approval-drift" && f.severity === "warn")).toBe(true)
  })

  it("does not report approval drift when the hash matches", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const content = await fs.readFile(path.join(base, "spec.md"), "utf-8")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.approvals.spec.approved = true
      sj.approvals.spec.hash = computeBodyChecksum(content)
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "approval-drift")).toBe(false)
  })

  it("reports error for ready_violation when ready_for_implementation set but artifacts missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.ready_for_implementation = true
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "ready-violation" && f.severity === "error")).toBe(true)
  })

  it("reports warn when spec.md contains NEEDS CLARIFICATION", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const specPath = path.join(worktree, "specs", "001-auth", "spec.md")
    await fs.appendFile(specPath, "\n[NEEDS CLARIFICATION] auth flow\n")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "spec-clarity" && f.severity === "warn")).toBe(true)
  })

  it("reports info when tasks.md has no Boundary annotations", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const tasksPath = path.join(worktree, "specs", "001-auth", "tasks.md")
    await fs.writeFile(tasksPath, "# Tasks\n- Task one\n- Task two")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "tasks-boundary" && f.severity === "info")).toBe(true)
  })

  it("accepts the field boundary format in tasks.md", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const tasksPath = path.join(worktree, "specs", "001-auth", "tasks.md")
    await fs.writeFile(tasksPath, "# Tasks\n- Task one\n- **Boundary**: Auth\n- Task two\n- **Boundary**: Auth")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "tasks-boundary")).toBe(false)
  })

  it("reports info when guard debug mode is enabled", async () => {
    await createConstitution(worktree)
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), JSON.stringify({ debug: true }), "utf-8")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "guard-debug" && f.severity === "info")).toBe(true)
  })

  it("does not report guard debug when disabled", async () => {
    await createConstitution(worktree)
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), JSON.stringify({ debug: false }), "utf-8")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "guard-debug")).toBe(false)
  })

  it("reports info for optional artifacts", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    await fs.mkdir(path.join(base, "contracts"), { recursive: true })
    await fs.writeFile(path.join(base, "research.md"), "# Research")
    const result = await auditTool.execute({}, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "optional-artifact" && f.message.includes("research.md"))).toBe(true)
    expect(findings.some((f: AuditFinding) => f.category === "optional-artifact" && f.message.includes("contracts/"))).toBe(true)
  })

  it("passes audit when no errors", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const result = await auditTool.execute({}, ctx)
    expect(result.metadata?.passed).toBe(true)
    expect(result.metadata?.errorCount).toBe(0)
  })
})

describe("audit auto-fix", () => {
  it("fixes phase mismatch when fix=true", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result = await auditTool.execute({ fix: true }, ctx)
    const findings = result.metadata?.findings ?? []
    const fixed = findings.filter((f: AuditFinding) => f.message.includes("auto-fixed"))
    expect(fixed.length).toBeGreaterThanOrEqual(1)
    const fixedSj = await readSpecJson(base)
    // A spec-only feature falls back to its spec milestone instead of advancing to the missing plan.
    expect(fixedSj?.phase).toBe("spec")
  })

  it("repairs a lost artifact back to the last generated milestone", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    await fs.rm(path.join(base, "tasks.md"))

    const repair = await auditTool.execute({ fix: true }, ctx)
    expect(repair.output).toContain("auto-fixed")
    const repaired = (await readSpecJson(base))!
    expect(repaired.phase).toBe("plan")
    expect(repaired.ready_for_implementation).toBe(false)

    const reaudit = await auditTool.execute({}, ctx)
    expect(reaudit.metadata?.errorCount).toBe(0)
  })

  it("recalculates summary after fix so error count drops (F-4)", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const before = await auditTool.execute({ fix: false }, ctx)
    expect(before.metadata?.errorCount).toBeGreaterThanOrEqual(1)
    expect(before.title).toContain("issue")
    const after = await auditTool.execute({ fix: true }, ctx)
    expect(after.metadata?.errorCount).toBe(0)
    expect(after.metadata?.passed).toBe(true)
  })

  it("does not create spec.json when missing (unfixable)", async () => {
    await createConstitution(worktree)
    await fs.mkdir(path.join(worktree, "specs", "001-auth"), { recursive: true })
    await fs.writeFile(path.join(worktree, "specs", "001-auth", "spec.md"), "# Auth")
    const result = await auditTool.execute({ fix: true }, ctx)
    const findings = result.metadata?.findings ?? []
    expect(findings.some((f: AuditFinding) => f.category === "spec-json")).toBe(true)
  })

  it("fixes ready-violation when fix=true", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.ready_for_implementation = true
    await writeSpecJson(sj, base)
    const result = await auditTool.execute({ fix: true }, ctx)
    const findings = result.metadata?.findings ?? []
    const fixed = findings.filter((f: AuditFinding) => f.message.includes("auto-fixed") && f.category === "ready-violation")
    expect(fixed.length).toBeGreaterThanOrEqual(1)
    const fixedSj = await readSpecJson(base)
    expect(fixedSj?.ready_for_implementation).toBe(false)
  })

  it("fixes approval when fix=true", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = (await readSpecJson(base))!
    sj.approvals.spec.generated = false
    await writeSpecJson(sj, base)
    const result = await auditTool.execute({ fix: true }, ctx)
    const findings = result.metadata?.findings ?? []
    const fixed = findings.filter((f: AuditFinding) => f.message.includes("auto-fixed") && f.category === "approval")
    expect(fixed.length).toBeGreaterThanOrEqual(1)
    const fixedSj = await readSpecJson(base)
    expect(fixedSj?.approvals.spec.generated).toBe(true)
  })

  it("does not overcorrect approval when feature name contains phase substring (artifact field)", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "tasks view", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-tasks-view")
    let sj = await readSpecJson(base)
    expect(sj).not.toBeNull()
    if (!sj) return
    sj.approvals.spec.generated = false
    sj.approvals.tasks.generated = false
    await writeSpecJson(sj, base)
    const result = await auditTool.execute({ fix: true }, ctx)
    const findings = result.metadata?.findings ?? []
    const approvalFindings = findings.filter((f: AuditFinding) => f.category === "approval")
    const specFinding = approvalFindings.find((f: AuditFinding) => f.artifact === "spec")
    const tasksFinding = approvalFindings.find((f: AuditFinding) => f.artifact === "tasks")
    expect(specFinding).toBeDefined()
    expect(tasksFinding).toBeUndefined()
    const fixedSj = await readSpecJson(base)
    expect(fixedSj?.approvals.spec.generated).toBe(true)
    expect(fixedSj?.approvals.tasks.generated).toBe(false)
  })
})
