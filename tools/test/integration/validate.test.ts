import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import validateTool from "../../speckit-validate"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, writeSpecJson, makeSpecJson, readSession } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("validate without constitution or features", () => {
  it("returns empty phase when no constitution and no features", async () => {
    const result = await validateTool.execute({}, ctx)
    expect(result.metadata?.phase).toBe("empty")
    expect(result.metadata?.valid).toBe(false)
    expect(result.metadata?.nextCommand).toContain("constitution")
  })

  it("returns empty phase but suggests /spec when constitution exists", async () => {
    await createConstitution(worktree)
    const result = await validateTool.execute({}, ctx)
    expect(result.metadata?.phase).toBe("empty")
    expect(result.metadata?.nextCommand).toContain("/spec")
  })
})

describe("validate with features", () => {
  it("returns spec phase when only spec.md exists", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.phase).toBe("spec")
    expect(result.metadata?.valid).toBe(false)
    expect(result.metadata?.artifacts?.spec).toBe(true)
    expect(result.metadata?.artifacts?.plan).toBe(false)
    expect(result.metadata?.artifacts?.tasks).toBe(false)
  })

  it("returns plan phase when spec and plan exist", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.phase).toBe("plan")
    expect(result.metadata?.valid).toBe(false)
    expect(result.metadata?.artifacts?.spec).toBe(true)
    expect(result.metadata?.artifacts?.plan).toBe(true)
    expect(result.metadata?.artifacts?.tasks).toBe(false)
  })

  it("returns tasks phase when all three artifacts exist (tasks not yet approved)", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.phase).toBe("tasks")
    expect(result.metadata?.valid).toBe(false)
  })

  it("returns spec phase when featureDir does not exist but constitution exists", async () => {
    await createConstitution(worktree)
    const result = await validateTool.execute({ featureDir: "999-nonexistent" }, ctx)
    expect(result.metadata?.phase).toBe("spec")
  })
})

describe("validate featureDir safety", () => {
  it.each(["specs/001-auth", "../escape", "a/b", "a\\b", ""])(
    "rejects the malformed featureDir %s without touching the session",
    async (bad) => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const before = await readSession(worktree)
      const result = await validateTool.execute({ featureDir: bad }, ctx)

      expect(result.title).toBe("Error")
      expect(result.output).toContain("Invalid featureDir:")
      expect(await readSession(worktree)).toStrictEqual(before)
    },
  )
})

describe("validate spec.json phase mismatches", () => {
  it("detects mismatch when spec.json says ready but files missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
    expect(result.metadata?.phase).not.toBe("ready")
  })

  it("detects mismatch when spec.json says impl but files missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "impl"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
  })

  it("detects mismatch when spec.json says complete but files missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "complete"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
  })

  it("detects mismatch when spec.json says spec but spec.md missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    await fs.rm(path.join(base, "spec.md"))
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "spec"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
  })

  it("detects mismatch when spec.json says spec but plan already exists", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "spec"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
  })

  it("detects mismatch when spec.json says plan but plan.md missing", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "plan"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(true)
  })

  it("no mismatch when spec.json matches reality", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.mismatch).toBe(false)
  })
})

describe("validate with impl/complete phases", () => {
  it("accepts impl phase when all files exist", async () => {
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
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.specJsonPhase).toBe("impl")
    expect(result.metadata?.mismatch).toBe(false)
  })

  it("accepts complete phase when all files exist", async () => {
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
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.metadata?.specJsonPhase).toBe("complete")
    expect(result.metadata?.mismatch).toBe(false)
  })
})

describe("validate output formatting", () => {
  it("includes WARN in output when mismatch detected", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.output).toContain("WARN")
  })

  it("returns Ready title when spec.json phase is ready", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "ready"
      sj.approvals.tasks.approved = true
      await writeSpecJson(sj, base)
    }
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.title).toBe("Ready to implement")
  })
})

describe("validate with corrupted spec.json", () => {
  it("shows WARN when spec.json is corrupted", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const specJsonFile = path.join(base, "spec.json")
    await fs.writeFile(specJsonFile, "{invalid json", "utf-8")
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.output).toContain("WARN: spec.json corrupted")
  })

  it("does not show warning when spec.json does not exist", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const specJsonFile = path.join(base, "spec.json")
    await fs.rm(specJsonFile, { force: true })
    const result = await validateTool.execute({ featureDir: "001-auth" }, ctx)
    expect(result.output).not.toContain("WARN: spec.json corrupted")
  })
})
