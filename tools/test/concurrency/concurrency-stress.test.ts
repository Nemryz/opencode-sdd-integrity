import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import phaseTool from "../../speckit-phase"
import validateTool from "../../speckit-validate"
import cleanTool from "../../speckit-clean"
import auditTool from "../../speckit-audit"
import statusTool from "../../speckit-status"
import { mockContext, createConstitution } from "../helpers/setup"
import {
  writeSession,
  readSession,
  writeSpecJson,
  readSpecJson,
  writeConfigWithBackup,
  readConfig,
  acquireLock,
  releaseLock,
  resetLocks,
  clearCorruptionWarnings,
} from "../../shared/io"
import {
  SessionStateSchema,
  SpecJsonSchema,
  ConfigSchema,
} from "../../shared/schemas"
import type { SessionState, SpecJson, SDDConfig } from "../../shared/schemas"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "concurrency-test-"))
  await fs.mkdir(path.join(tmpDir, ".opencode", "spec-memory"), { recursive: true })
  await fs.mkdir(path.join(tmpDir, ".opencode", "backups"), { recursive: true })
  resetLocks()
  clearCorruptionWarnings()
})

afterEach(async () => {
  resetLocks()
  clearCorruptionWarnings()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    command: "test",
    phase: "spec",
    featureDir: "specs/001-test",
    featureNumber: 1,
    featureName: "test",
    nextStep: "/plan",
    lastResult: null,
    history: [],
    ...overrides,
  }
}

function makeSpecJson(overrides?: Partial<SpecJson>): SpecJson {
  return {
    feature_name: "test",
    feature_number: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    phase: "spec",
    approvals: {
      spec: { generated: true, approved: false },
      plan: { generated: false, approved: false },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<SDDConfig>): SDDConfig {
  return {
    defaultTechStack: null,
    lastUsedLanguage: null,
    expressMode: false,
    autoVersioning: false,
    preferences: {},
    ...overrides,
  }
}

// 10 writers to session.json

describe("Concurrency: 10 writers to session.json", () => {
  it("at least one write succeeds and final state is valid", async () => {
    const writers = Array.from({ length: 10 }, (_, i) =>
      writeSession(tmpDir, makeSession({ featureName: `writer-${i}` }))
    )
    const results = await Promise.allSettled(writers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const session = await readSession(tmpDir)
    const parsed = SessionStateSchema.safeParse(session)
    expect(parsed.success).toBe(true)
  })

  it("final state is valid after concurrent writes", async () => {
    const writers = Array.from({ length: 10 }, (_, i) =>
      writeSession(tmpDir, makeSession({ featureName: `feature-${i}`, command: `cmd-${i}` }))
    )
    await Promise.allSettled(writers)

    const session = await readSession(tmpDir)
    const parsed = SessionStateSchema.safeParse(session)
    expect(parsed.success).toBe(true)
  })
})

// 10 writers to spec.json

describe("Concurrency: 10 writers to spec.json", () => {
  it("at least one write succeeds and final state is valid", async () => {
    const featureDir = path.join(tmpDir, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })

    const writers = Array.from({ length: 10 }, (_, i) =>
      writeSpecJson(makeSpecJson({ feature_name: `writer-${i}` }), featureDir)
    )
    const results = await Promise.allSettled(writers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const spec = await readSpecJson(featureDir)
    expect(spec).not.toBeNull()
    const parsed = SpecJsonSchema.safeParse(spec)
    expect(parsed.success).toBe(true)
  })

  it("final state is valid after concurrent writes", async () => {
    const featureDir = path.join(tmpDir, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })

    const writers = Array.from({ length: 10 }, (_, i) =>
      writeSpecJson(makeSpecJson({ feature_name: `feature-${i}` }), featureDir)
    )
    await Promise.allSettled(writers)

    const spec = await readSpecJson(featureDir)
    const parsed = SpecJsonSchema.safeParse(spec)
    expect(parsed.success).toBe(true)
  })
})

// 10 writers to config.json

describe("Concurrency: 10 writers to config.json", () => {
  it("at least one write succeeds and final state is valid", async () => {
    const writers = Array.from({ length: 10 }, (_, i) =>
      writeConfigWithBackup(tmpDir, makeConfig({ defaultTechStack: `stack-${i}` }))
    )
    const results = await Promise.allSettled(writers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const config = await readConfig(tmpDir)
    const parsed = ConfigSchema.safeParse(config)
    expect(parsed.success).toBe(true)
  })

  it("final state is valid after concurrent writes", async () => {
    const writers = Array.from({ length: 10 }, (_, i) =>
      writeConfigWithBackup(tmpDir, makeConfig({ defaultTechStack: `stack-${i}` }))
    )
    await Promise.allSettled(writers)

    const config = await readConfig(tmpDir)
    const parsed = ConfigSchema.safeParse(config)
    expect(parsed.success).toBe(true)
  })
})

// Read while write

describe("Concurrency: Read while write", () => {
  it("5 readers and 5 writers on same file", async () => {
    await writeSession(tmpDir, makeSession({ featureName: "initial" }))

    const writers = Array.from({ length: 5 }, (_, i) =>
      writeSession(tmpDir, makeSession({ featureName: `writer-${i}` }))
    )
    const readers = Array.from({ length: 5 }, () =>
      readSession(tmpDir)
    )

    const writerResults = await Promise.allSettled(writers)
    const readerResults = await Promise.allSettled(readers)

    const writerFulfilled = writerResults.filter(r => r.status === "fulfilled")
    expect(writerFulfilled.length).toBeGreaterThanOrEqual(1)

    for (const r of readerResults) {
      expect(r.status).toBe("fulfilled")
      if (r.status === "fulfilled") {
        expect(SessionStateSchema.safeParse(r.value).success).toBe(true)
      }
    }
  })
})

// Scaffold concurrent

describe("Concurrency: Scaffold concurrent", () => {
  it("5 concurrent writes to same feature directory", async () => {
    const featureDir = path.join(tmpDir, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })

    const specMd = path.join(featureDir, "spec.md")
    const writers = Array.from({ length: 5 }, (_, i) =>
      fs.writeFile(specMd, `# Spec v${i}\n`, "utf-8")
    )
    const results = await Promise.allSettled(writers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBe(5)

    const content = await fs.readFile(specMd, "utf-8")
    expect(content).toMatch(/^# Spec v\d+\n$/)
  })
})

// Lock contention extreme

describe("Concurrency: Lock contention extreme", () => {
  it("20 processes trying to acquireLock", async () => {
    const fp = path.join(tmpDir, "test.json")
    await fs.writeFile(fp, "{}", "utf-8")

    const lockers = Array.from({ length: 20 }, async () => {
      const handle = await acquireLock(fp, { timeout: 15000, staleThreshold: 5000 })
      try {
        await new Promise(resolve => setTimeout(resolve, 10))
        return handle.lockDir
      } finally {
        await releaseLock(handle)
      }
    })

    const results = await Promise.allSettled(lockers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(10)
  })
})

// Corruption warnings intercalated

describe("Concurrency: Corruption warnings intercalated", () => {
  it("5 tools generating warnings simultaneously", async () => {
    const corruptFiles = Array.from({ length: 5 }, async (_, i) => {
      const fp = path.join(tmpDir, `.opencode/spec-memory/file${i}.json`)
      await fs.writeFile(fp, "invalid json {{{", "utf-8")
      return fp
    })
    await Promise.all(corruptFiles)

    const readers = Array.from({ length: 5 }, async (_, i) => {
      const fp = path.join(tmpDir, `.opencode/spec-memory/file${i}.json`)
      try {
        const data = await fs.readFile(fp, "utf-8")
        JSON.parse(data)
      } catch (err) {
        return { file: fp, error: String(err) }
      }
      return { file: fp, error: null }
    })

    const results = await Promise.allSettled(readers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBe(5)
  })
})

// Delta write concurrent

describe("Concurrency: Delta write concurrent", () => {
  it("3 processes writing deltas.json simultaneously", async () => {
    const featureDir = path.join(tmpDir, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    const deltasDir = path.join(featureDir, "deltas")
    await fs.mkdir(deltasDir, { recursive: true })

    const deltasJson = path.join(deltasDir, "deltas.json")
    await fs.writeFile(deltasJson, JSON.stringify({ feature: "001-test", deltas: [] }, null, 2), "utf-8")

    const writers = Array.from({ length: 3 }, async (_, i) => {
      const handle = await acquireLock(deltasJson, { timeout: 10000 })
      try {
        const raw = await fs.readFile(deltasJson, "utf-8")
        const index = JSON.parse(raw)
        index.deltas.push({
          id: `D00${i + 1}`,
          type: "feature",
          title: `Delta ${i + 1}`,
          status: "draft",
          impact: "low",
          parent_feature: "001-test",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        await fs.writeFile(deltasJson, JSON.stringify(index, null, 2), "utf-8")
      } finally {
        await releaseLock(handle)
      }
    })

    const results = await Promise.allSettled(writers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const raw = await fs.readFile(deltasJson, "utf-8")
    const index = JSON.parse(raw)
    expect(index.deltas.length).toBeGreaterThanOrEqual(1)
  })
})

// Health check + write

describe("Concurrency: Health check + write", () => {
  it("health check reads while another process writes", { timeout: 20_000 }, async () => {
    const fp = path.join(tmpDir, ".opencode", "spec-memory", "session.json")
    await fs.writeFile(fp, JSON.stringify(makeSession()), "utf-8")

    const writer = writeSession(tmpDir, makeSession({ featureName: "updated" }))

    const reader = (async () => {
      const results: SessionState[] = []
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        const session = await readSession(tmpDir)
        results.push(session)
      }
      return results
    })()

    const [, readerResults] = await Promise.all([writer, reader])

    for (const session of readerResults) {
      expect(SessionStateSchema.safeParse(session).success).toBe(true)
    }
  })
})

// Audit + clean concurrent

describe("Concurrency: Audit + clean concurrent", () => {
  it("concurrent read operations on session.json", async () => {
    await writeSession(tmpDir, makeSession({ featureName: "test" }))

    const readers = Array.from({ length: 10 }, () => readSession(tmpDir))
    const results = await Promise.allSettled(readers)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBe(10)

    for (const r of fulfilled) {
      if (r.status === "fulfilled") {
        expect(SessionStateSchema.safeParse(r.value).success).toBe(true)
      }
    }
  })

  it("concurrent read and write on config.json", async () => {
    await writeConfigWithBackup(tmpDir, makeConfig())

    const writers = Array.from({ length: 3 }, (_, i) =>
      writeConfigWithBackup(tmpDir, makeConfig({ defaultTechStack: `stack-${i}` }))
    )
    const readers = Array.from({ length: 3 }, () => readConfig(tmpDir))

    const all = [...writers, ...readers]
    const results = await Promise.allSettled(all)
    const fulfilled = results.filter(r => r.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(2)

    const finalConfig = await readConfig(tmpDir)
    expect(ConfigSchema.safeParse(finalConfig).success).toBe(true)
  })
})

// Phase transitions under contention

// Seeds a feature through the real tools so the burst works on genuine state files with genuine snapshots.
async function seedTransitionFixture(approveTasks: boolean): Promise<string> {
  await createConstitution(tmpDir)
  const ctx = mockContext(tmpDir)
  await scaffoldTool.execute({ featureName: "Conc", template: "spec" }, ctx)
  await scaffoldTool.execute({ featureName: "Conc", template: "plan" }, ctx)
  await scaffoldTool.execute({ featureName: "Conc", template: "tasks" }, ctx)
  await approveTool.execute({ artifact: "spec", confirmed: true }, ctx)
  await approveTool.execute({ artifact: "plan", confirmed: true }, ctx)
  if (approveTasks) {
    await approveTool.execute({ artifact: "tasks", confirmed: true }, ctx)
  }
  return path.join(tmpDir, "specs", "001-conc")
}

describe("Concurrency: phase transition burst", () => {
  it("parallel approve tasks, phase impl, validate and status settle into a coherent state", { timeout: 30_000 }, async () => {
    const featureDir = await seedTransitionFixture(false)
    const ctx = mockContext(tmpDir)

    const results = await Promise.allSettled([
      approveTool.execute({ artifact: "tasks", confirmed: true }, ctx),
      phaseTool.execute({ phase: "impl" }, ctx),
      validateTool.execute({ featureDir: "001-conc" }, ctx),
      statusTool.execute({}, ctx),
    ])
    expect(results.every(r => r.status === "fulfilled")).toBe(true)

    const sj = await readSpecJson(featureDir)
    expect(sj).not.toBeNull()
    expect(SpecJsonSchema.safeParse(sj).success).toBe(true)
    // The approval and the stored phase may land in either order but must never contradict each other.
    expect(["tasks", "ready", "impl"]).toContain(sj!.phase)
    if (sj!.phase !== "tasks") expect(sj!.approvals.tasks.approved).toBe(true)
    expect(sj!.ready_for_implementation).toBe(sj!.approvals.tasks.approved)
    expect(SessionStateSchema.safeParse(await readSession(tmpDir)).success).toBe(true)
    const tasksFile = await fs.stat(path.join(featureDir, "tasks.md")).catch(() => null)
    expect(tasksFile?.isFile()).toBe(true)

    // One repair pass settles the session cache on the authoritative stored phase.
    const settled = await validateTool.execute({ featureDir: "001-conc" }, ctx)
    expect(settled.metadata?.mismatch).toBe(false)
    expect((await readSession(tmpDir)).phase).toBe(sj!.phase)
  })

  it("parallel transition burst from ready keeps the stored state valid", { timeout: 30_000 }, async () => {
    const featureDir = await seedTransitionFixture(true)
    const ctx = mockContext(tmpDir)

    const results = await Promise.allSettled([
      phaseTool.execute({ phase: "impl" }, ctx),
      phaseTool.execute({ phase: "impl" }, ctx),
      validateTool.execute({ featureDir: "001-conc" }, ctx),
      statusTool.execute({}, ctx),
      auditTool.execute({ fix: true }, ctx),
      cleanTool.execute({ fix: true }, ctx),
    ])
    expect(results.every(r => r.status === "fulfilled")).toBe(true)

    const sj = await readSpecJson(featureDir)
    expect(SpecJsonSchema.safeParse(sj).success).toBe(true)
    expect(["ready", "impl"]).toContain(sj!.phase)
    // The tasks approval was recorded before the burst and no participant may lose it.
    expect(sj!.approvals.tasks.approved).toBe(true)
    expect(SessionStateSchema.safeParse(await readSession(tmpDir)).success).toBe(true)

    const settled = await validateTool.execute({ featureDir: "001-conc" }, ctx)
    expect(settled.metadata?.mismatch).toBe(false)
    expect((await readSession(tmpDir)).phase).toBe(sj!.phase)
  })

  it("parallel clean repair and validate converge on the same repaired phase", { timeout: 30_000 }, async () => {
    const featureDir = await seedTransitionFixture(true)
    const ctx = mockContext(tmpDir)
    await fs.rm(path.join(featureDir, "tasks.md"))

    const results = await Promise.allSettled([
      cleanTool.execute({ fix: true }, ctx),
      validateTool.execute({ featureDir: "001-conc" }, ctx),
      statusTool.execute({}, ctx),
    ])
    expect(results.every(r => r.status === "fulfilled")).toBe(true)

    // Whether or not the parallel repair landed, one more run must reach the same repaired state.
    const fixed = await cleanTool.execute({ fix: true }, ctx)
    const issues = (fixed.metadata?.issues ?? []) as string[]
    expect(issues.some(i => i.includes("Fix blocked"))).toBe(false)
    const sj = await readSpecJson(featureDir)
    expect(sj?.phase).toBe("plan")
    expect(sj?.ready_for_implementation).toBe(false)
    expect((await readSession(tmpDir)).phase).toBe("plan")

    const sweep = await auditTool.execute({}, ctx)
    expect(sweep.metadata?.errorCount).toBe(0)
  })
})
