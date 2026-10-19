import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import selfhealTool from "../../speckit-selfheal"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("selfheal health scan", () => {
  it("returns error when no worktree", async () => {
    const result = await selfhealTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("No worktree path")
  })

  it("returns error for invalid project root", async () => {
    const badCtx = mockContext(path.join(worktree, "nonexistent"))
    const result = await selfhealTool.execute({}, badCtx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("scans an empty project and returns findings", async () => {
    const result = await selfhealTool.execute({}, ctx)
    expect(result.title).toContain("SelfHeal")
    expect(result.metadata).toBeDefined()
    const meta = result.metadata as Record<string, unknown>
    expect(typeof meta.total).toBe("number")
    expect(typeof meta.summary).toBe("object")
  })

  it("scans a project with constitution and reports it", async () => {
    await scaffoldTool.execute({ featureName: "TestProj", template: "constitution" }, ctx)
    const result = await selfhealTool.execute({}, ctx)
    const lines = (result.output as string).split("\n")
    const hasConstitutionFinding = lines.some(l => l.includes("Constitution"))
    expect(hasConstitutionFinding).toBe(true)
  })

  it("returns categorized findings with proper structure", async () => {
    await scaffoldTool.execute({ featureName: "TestProj", template: "constitution" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await selfhealTool.execute({}, ctx)
    const meta = result.metadata as { findings: Array<Record<string, unknown>> }
    expect(Array.isArray(meta.findings)).toBe(true)
    for (const f of meta.findings) {
      expect(f).toHaveProperty("id")
      expect(f).toHaveProperty("source")
      expect(f).toHaveProperty("severity")
      expect(f).toHaveProperty("category")
      expect(f).toHaveProperty("message")
      expect(["BUG", "MISSING_TEST", "HARDENING", "DOCS"]).toContain(f.category)
      expect(["LOW", "MED", "HIGH"]).toContain(f.severity)
    }
  })

  it("keeps metadata JSON-tight so the runtime can persist the tool part", async () => {
    await scaffoldTool.execute({ featureName: "TestProj", template: "constitution" }, ctx)
    const result = await selfhealTool.execute({}, ctx)
    const meta = result.metadata as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(meta))).toStrictEqual(meta)
    const findings = meta.findings as Array<Record<string, unknown>>
    const noSteering = findings.find(f => f.message === "No steering directory (optional)")
    expect(noSteering).toBeDefined()
    expect("file" in (noSteering as Record<string, unknown>)).toBe(false)
  })

  it("orders findings by severity (HIGH first)", async () => {
    await scaffoldTool.execute({ featureName: "TestProj", template: "constitution" }, ctx)
    const result = await selfhealTool.execute({}, ctx)
    const meta = result.metadata as { findings: Array<Record<string, unknown>> }
    const severities = meta.findings.map(f => f.severity)
    const highIdx = severities.indexOf("HIGH")
    const medIdx = severities.indexOf("MED")
    const lowIdx = severities.indexOf("LOW")
    if (highIdx >= 0 && medIdx >= 0) {
      expect(highIdx).toBeLessThan(medIdx)
    }
    if (medIdx >= 0 && lowIdx >= 0) {
      expect(medIdx).toBeLessThan(lowIdx)
    }
  })
})

describe("selfheal with fix flag", () => {
  it("runs fix and returns fix counts", async () => {
    await scaffoldTool.execute({ featureName: "TestProj", template: "constitution" }, ctx)
    const result = await selfhealTool.execute({ fix: true }, ctx)
    expect(result.title).toContain("SelfHeal")
    const meta = result.metadata as { fixed: number; skipped: number; failed: number }
    expect(typeof meta.fixed).toBe("number")
    expect(typeof meta.skipped).toBe("number")
    expect(typeof meta.failed).toBe("number")
  })
})
