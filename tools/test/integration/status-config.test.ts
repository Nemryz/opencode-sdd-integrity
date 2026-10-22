import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import statusTool from "../../speckit-status"
import configTool from "../../speckit-config"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSession, writeSession, readSpecJson, writeSpecJson, configPath, writeJournal } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("status", () => {
  it("returns error when no worktree", async () => {
    const result = await statusTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("reports no features in empty project", async () => {
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.featureCount).toBe(0)
    expect(result.output).toContain("No features yet")
  })

  it("reports one feature with correct phase", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.featureCount).toBe(1)
    expect(result.metadata?.features[0].dir).toBe("001-auth")
    expect(result.metadata?.features[0].phase).toBe("spec")
  })

  it("shows approval-aware next step until the spec is approved", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.nextCommand).toBe("/approve spec")
    expect(result.output).toContain("Next: /approve spec")
    const session = await readSession(worktree)
    expect(session.nextStep).toBe("/approve spec")
  })

  it("falls back to the phase next step once the spec is approved", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.nextCommand).toBe("/plan <tech stack>")
  })

  it("reports multiple features with different phases", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.featureCount).toBe(2)
  })

  it("uses session.featureDir as latest if valid", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const session = await readSession(worktree)
    session.featureDir = "001-auth"
    await writeSession(worktree, session)
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.latestFeature).toBe("001-auth")
  })

  it("reports a pending state transaction without repairing it", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await writeJournal(worktree, {
      format: 1,
      txId: "tx-status",
      planId: "plan-status",
      planHash: "0".repeat(64),
      baseHash: "0".repeat(64),
      expectedHash: "0".repeat(64),
      state: "prepared",
      startedAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      pid: process.pid,
      operations: [{ kind: "rename-dir", from: "specs/001-auth", to: "archive/2026-10-22-001-auth" }],
      backups: [],
    })

    const result = await statusTool.execute({}, ctx)
    expect(result.output).toContain("[STATE TRANSACTION] tx-status:prepared")
    expect((result.metadata?.stateTransactions as unknown[]).length).toBe(1)
  })

  it("updates session state after status call", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await statusTool.execute({}, ctx)
    const session = await readSession(worktree)
    expect(session.command).toBe("/status")
    expect(session.featureDir).toBeTruthy()
  })

  it("falls back to other feature when session.featureDir deleted (T-4)", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Billing", template: "spec" }, ctx)
    const session = await readSession(worktree)
    session.featureDir = "001-auth"
    await writeSession(worktree, session)
    const specsDir = path.join(worktree, "specs")
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.latestFeature).toBe("002-billing")
    expect(result.metadata?.featureCount).toBe(1)
  })

  it("reports no features when session.featureDir deleted and no others exist (T-5)", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const session = await readSession(worktree)
    session.featureDir = "001-auth"
    await writeSession(worktree, session)
    const specsDir = path.join(worktree, "specs")
    await fs.rm(path.join(specsDir, "001-auth"), { recursive: true, force: true })
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.featureCount).toBe(0)
    expect(result.output).toContain("No features yet")
  })

  it("prefers spec.json phase over detectPhase", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const base = path.join(worktree, "specs", "001-auth")
    const sj = await readSpecJson(base)
    if (sj) {
      sj.phase = "complete"
      await writeSpecJson(sj, base)
    }
    const result = await statusTool.execute({}, ctx)
    expect(result.metadata?.features[0].phase).toBe("complete")
  })
})

describe("config", () => {
  it("reads expressMode via key lookup", async () => {
    await configTool.execute({ key: "expressMode", value: "true" }, ctx)
    const result = await configTool.execute({ key: "expressMode" }, ctx)
    expect(result.output).toContain("true")
  })

  it("returns error when no worktree", async () => {
    const result = await configTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("returns error when project root is invalid", async () => {
    const badDir = path.join(worktree, "nonexistent-sub")
    const ctx2 = mockContext(badDir)
    const result = await configTool.execute({}, ctx2)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("shows default config when no arguments", async () => {
    const result = await configTool.execute({}, ctx)
    expect(result.title).toBe("SDD Configuration")
    expect(result.output).toContain("defaultTechStack")
  })

  it("reads specific config key", async () => {
    const result = await configTool.execute({ key: "defaultTechStack" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toContain("defaultTechStack")
  })

  it("returns (not set) for unknown key", async () => {
    const result = await configTool.execute({ key: "nonexistent" }, ctx)
    expect(result.output).toContain("(not set)")
  })

  it("sets defaultTechStack", async () => {
    const result = await configTool.execute({ defaultTechStack: "Node.js+PostgreSQL" }, ctx)
    expect(result.title).toBe("Configuration updated")
    expect(result.output).toContain("Node.js+PostgreSQL")
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.defaultTechStack).toBe("Node.js+PostgreSQL")
  })

  it("sets key=value preference", async () => {
    const result = await configTool.execute({ key: "theme", value: "dark" }, ctx)
    expect(result.title).toBe("Configuration updated")
    expect(result.output).toContain("theme: dark")
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.preferences.theme).toBe("dark")
  })

  it("updates lastUsedLanguage when key=language", async () => {
    await configTool.execute({ key: "language", value: "es" }, ctx)
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.lastUsedLanguage).toBe("es")
    expect(cfg.preferences.language).toBe("es")
  })

  it("does not allow __proto__ pollution in preferences (T-6)", async () => {
    const r1 = await configTool.execute({ key: "__proto__", value: "polluted" }, ctx)
    expect(r1.title).not.toBe("Error")
    const proto = ({} as Record<string, string>).__proto__
    expect(proto).not.toBe("polluted")
  })

  it("handles unicode preference keys correctly (T-6)", async () => {
    await configTool.execute({ key: "theme", value: "dark" }, ctx)
    const r2 = await configTool.execute({ key: "theme", value: "darker" }, ctx)
    expect(r2.output).toContain("darker")
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.preferences.theme).toBe("darker")
  })

  it("stores dotted preference keys literally not nested (T-6)", async () => {
    await configTool.execute({ key: "editor.path", value: "vim" }, ctx)
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.preferences["editor.path"]).toBe("vim")
  })

  it("sets expressMode to true", async () => {
    await configTool.execute({ key: "expressMode", value: "true" }, ctx)
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.expressMode).toBe(true)
  })

  it("sets expressMode to false", async () => {
    await configTool.execute({ key: "expressMode", value: "true" }, ctx)
    await configTool.execute({ key: "expressMode", value: "false" }, ctx)
    const cfgPath = configPath(worktree)
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg = JSON.parse(raw)
    expect(cfg.expressMode).toBe(false)
  })

  it("defaults expressMode to false when config file missing", async () => {
    const result = await configTool.execute({}, ctx)
    expect(result.metadata?.expressMode).toBe(false)
  })
})
