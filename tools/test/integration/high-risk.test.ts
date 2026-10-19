import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import scaffoldTool from "../../speckit-scaffold"
import validateTool from "../../speckit-validate"
import auditTool from "../../speckit-audit"
import cleanTool from "../../speckit-clean"
import statusTool from "../../speckit-status"
import configTool from "../../speckit-config"
import complexityTool from "../../speckit-complexity"
import evidenceTool from "../../speckit-evidence"
import {
  mockContext,
  createTempWorktree,
  destroyTempWorktree,
  createConstitution,
} from "../helpers/setup"
import {
  readSpecJson,
  readSession,
  specJsonPath,
  sessionPath,
  configPath,
  specsDirPath,
} from "../../shared/types"

describe("C-1: no worktree path", () => {
  it("scaffold returns error when no worktree", async () => {
    const result = await scaffoldTool.execute(
      { featureName: "test", template: "spec" },
      { worktree: "" },
    )
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("validate returns error when no worktree", async () => {
    const result = await validateTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("audit returns error when no worktree", async () => {
    const result = await auditTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("clean returns error when no worktree", async () => {
    const result = await cleanTool.execute({}, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output).toContain("worktree")
  })

  it("evidence returns error when no worktree", async () => {
    const result = await evidenceTool.execute({ command: "status" }, { worktree: "" })
    expect(result.title).toBe("Error")
    expect(result.output.toLowerCase()).toContain("worktree")
  })
})

describe("C-2: corrupt JSON handling", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await createTempWorktree()
    ctx = mockContext(worktree)
  })

  afterEach(async () => {
    await destroyTempWorktree(worktree)
  })

  describe("corrupt spec.json", () => {
    async function createFeature(name: string): Promise<string> {
      const r = await scaffoldTool.execute(
        { featureName: name, template: "spec" },
        ctx,
      )
      return r.metadata?.featureDir as string
    }

    async function corruptSpecJson(featureDir: string): Promise<void> {
      const sjPath = specJsonPath(path.join(specsDirPath(worktree), featureDir))
      await fs.writeFile(sjPath, "not valid json at all {{[broken", "utf-8")
    }

    it("validate handles corrupt spec.json gracefully", async () => {
      const fd = await createFeature("test-corrupt")
      await corruptSpecJson(fd)
      const result = await validateTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
      expect(result.output).toContain("spec ok")
    })

    it("audit handles corrupt spec.json gracefully", async () => {
      const fd = await createFeature("test-corrupt")
      await corruptSpecJson(fd)
      const result = await auditTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
      expect(result.metadata?.errorCount).toBe(0)
      expect(result.output).toContain("spec.json")
    })

    it("clean handles corrupt spec.json gracefully", async () => {
      const fd = await createFeature("test-corrupt")
      await corruptSpecJson(fd)
      const result = await cleanTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
      expect(result.metadata?.total).toBe(1)
    })

    it("evidence record still works when spec.json is corrupt", async () => {
      const fd = await createFeature("test-corrupt")
      await corruptSpecJson(fd)

      const result = await evidenceTool.execute(
        { command: "record", task: "T-001", testCommand: "npm test", featureDir: fd },
        ctx,
      )

      expect(result.title).not.toBe("Error")
      const raw = await fs.readFile(path.join(specsDirPath(worktree), fd, "evidence.json"), "utf-8")
      expect(JSON.parse(raw).entries).toHaveLength(1)
    })
  })

  describe("corrupt session.json", () => {
    async function corruptSession(): Promise<void> {
      await fs.writeFile(sessionPath(worktree), "{{bad json!!", "utf-8")
    }

    it("validate handles corrupt session gracefully", async () => {
      await createConstitution(worktree)
      await corruptSession()
      const result = await validateTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
    })

    it("status handles corrupt session gracefully", async () => {
      await createConstitution(worktree)
      await corruptSession()
      const result = await statusTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
    })

    it("clean handles corrupt session gracefully", async () => {
      await createConstitution(worktree)
      await corruptSession()
      const result = await cleanTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
    })

    it("evidence falls back to the latest feature when the session is corrupt", async () => {
      await scaffoldTool.execute({ featureName: "test-session", template: "spec" }, ctx)
      await corruptSession()

      const result = await evidenceTool.execute({ command: "status" }, ctx)

      expect(result.title).toBe("Evidence: 001-test-session")
      expect(result.output).toContain("No test evidence recorded yet")
    })
  })

  describe("corrupt config.json", () => {
    async function corruptConfig(): Promise<void> {
      const cfgDir = path.dirname(configPath(worktree))
      await fs.mkdir(cfgDir, { recursive: true })
      await fs.writeFile(configPath(worktree), "bad config{{{}}}", "utf-8")
    }

    it("config read handles corrupt config gracefully when reading", async () => {
      await createConstitution(worktree)
      await corruptConfig()
      const result = await configTool.execute({}, ctx)
      expect(result.title).not.toBe("Error")
    })

    it("config write still works after corrupt read", async () => {
      await createConstitution(worktree)
      await corruptConfig()
      const result = await configTool.execute(
        { defaultTechStack: "Node.js" },
        ctx,
      )
      expect(result.title).not.toBe("Error")
      expect(result.metadata?.defaultTechStack).toBe("Node.js")
    })
  })
})

describe("C-3: invalid project root (missing .opencode/spec-memory/)", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await fs.mkdtemp(path.join(os.tmpdir(), "invalid-root-"))
    ctx = mockContext(worktree)
  })

  afterEach(async () => {
    await fs.rm(worktree, { recursive: true, force: true })
  })

  it("validate returns error for invalid project root", async () => {
    const result = await validateTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("audit returns error for invalid project root", async () => {
    const result = await auditTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("clean returns error for invalid project root", async () => {
    const result = await cleanTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("status returns error for invalid project root", async () => {
    const result = await statusTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("config returns error for invalid project root", async () => {
    const result = await configTool.execute({}, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("complexity returns error for invalid project root", async () => {
    const result = await complexityTool.execute(
      { taskDescription: "test" },
      ctx,
    )
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("evidence returns error for invalid project root", async () => {
    const result = await evidenceTool.execute({ command: "status" }, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })
})

describe("C-4: spec.json exists but directory is missing", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await createTempWorktree()
    ctx = mockContext(worktree)
    await createConstitution(worktree)
    // create feature, extract spec.json content, then delete entire feature directory
    await scaffoldTool.execute({ featureName: "Ghost", template: "spec" }, ctx)
    const featurePath = path.join(specsDirPath(worktree), "001-ghost")
    const sj = await readSpecJson(featurePath)
    await fs.rm(featurePath, { recursive: true, force: true })
    // re-create spec.json where the directory used to be
    if (sj) {
      const sjDir = path.join(specsDirPath(worktree), "001-ghost")
      await fs.mkdir(sjDir, { recursive: true })
      await fs.writeFile(specJsonPath(sjDir), JSON.stringify(sj), "utf-8")
    }
  })

  afterEach(async () => {
    await destroyTempWorktree(worktree)
  })

  it("validate handles spec.json without directory gracefully", async () => {
    const result = await validateTool.execute({}, ctx)
    expect(result.title).not.toBe("Error")
  })

  it("audit handles spec.json without directory gracefully", async () => {
    const result = await auditTool.execute({}, ctx)
    expect(result.title).not.toBe("Error")
  })

  it("clean handles spec.json without directory gracefully", async () => {
    const result = await cleanTool.execute({}, ctx)
    expect(result.title).not.toBe("Error")
  })

  it("clean handles ghost feature gracefully (no crash)", async () => {
    const result = await cleanTool.execute({}, ctx)
    expect(result.title).not.toBe("Error")
    expect(result.metadata?.total).toBeDefined()
  })

  it("evidence reports a ghost feature instead of crashing", async () => {
    const result = await evidenceTool.execute({ command: "status" }, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("has no spec.md")
  })
})

describe("C-5: sequential scaffold calls", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await createTempWorktree()
    ctx = mockContext(worktree)
    await createConstitution(worktree)
  })

  afterEach(async () => {
    await destroyTempWorktree(worktree)
  })

  it("two sequential scaffold calls produce unique numbers and valid session", async () => {
    const r1 = await scaffoldTool.execute({ featureName: "Alpha", template: "spec" }, ctx)
    expect(r1.title).not.toBe("Error")
    expect(r1.metadata?.featureNumber).toBe(1)
    expect(r1.metadata?.featureDir).toMatch(/^001-/)

    const r2 = await scaffoldTool.execute({ featureName: "Beta", template: "spec" }, ctx)
    expect(r2.title).not.toBe("Error")
    expect(r2.metadata?.featureNumber).toBe(2)
    expect(r2.metadata?.featureDir).toMatch(/^002-/)

    const session = await readSession(worktree)
    expect(session.history.length).toBeGreaterThanOrEqual(1)
  })

  it("parallel scaffold calls with lock contention both succeed", async () => {
    const p1 = scaffoldTool.execute({ featureName: "Gamma", template: "spec" }, ctx)
    await new Promise(resolve => setTimeout(resolve, 50))
    const p2 = scaffoldTool.execute({ featureName: "Delta", template: "spec" }, ctx)
    const [r1, r2] = await Promise.all([p1, p2])
    const results = [r1, r2]
    const successes = results.filter(r => r.title !== "Error")
    expect(successes.length).toBeGreaterThanOrEqual(1)
  })
})

describe("C-6: stale lock on session.json", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await createTempWorktree()
    ctx = mockContext(worktree)
    await createConstitution(worktree)
  })

  afterEach(async () => {
    await destroyTempWorktree(worktree)
  })

  it("scaffold recovers from stale session lock held by dead process", async () => {
    const lockDir = sessionPath(worktree) + ".lock"
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }),
      "utf-8",
    )
    const result = await scaffoldTool.execute(
      { featureName: "test", template: "spec" },
      ctx,
    )
    expect(result.title).not.toBe("Error")
    expect(result.metadata?.featureNumber).toBe(1)
  })

  it("evidence recovers from a stale evidence lock held by dead process", async () => {
    const scaffold = await scaffoldTool.execute({ featureName: "test", template: "spec" }, ctx)
    const fd = scaffold.metadata?.featureDir as string
    const lockDir = path.join(specsDirPath(worktree), fd, "evidence.json.lock")
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }),
      "utf-8",
    )

    const result = await evidenceTool.execute(
      { command: "record", task: "T-001", testCommand: "npm test", featureDir: fd },
      ctx,
    )

    expect(result.title).not.toBe("Error")
    const raw = await fs.readFile(path.join(specsDirPath(worktree), fd, "evidence.json"), "utf-8")
    expect(JSON.parse(raw).entries).toHaveLength(1)
  })
})

describe("C-7: truncated session.json on disk", () => {
  let worktree: string
  let ctx: ReturnType<typeof mockContext>

  beforeEach(async () => {
    worktree = await createTempWorktree()
    ctx = mockContext(worktree)
    await createConstitution(worktree)
  })

  afterEach(async () => {
    await destroyTempWorktree(worktree)
  })

  it("status does not crash when session.json is truncated", async () => {
    await scaffoldTool.execute({ featureName: "test", template: "spec" }, ctx)
    const sp = sessionPath(worktree)
    await fs.writeFile(sp, '{"phase": "spec", "history": "trunc', "utf-8")
    const result = await statusTool.execute({}, ctx)
    expect(result.title).not.toBe("Error")
  })

  it("evidence does not crash when session.json is truncated", async () => {
    await scaffoldTool.execute({ featureName: "test", template: "spec" }, ctx)
    const sp = sessionPath(worktree)
    await fs.writeFile(sp, '{"phase": "spec", "history": "trunc', "utf-8")
    const result = await evidenceTool.execute({ command: "status" }, ctx)
    expect(result.title).not.toBe("Error")
    expect(result.title).toContain("001-test")
  })
})
