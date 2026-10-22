import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  applyStatePlan,
  createStatePlan,
  hashPathTree,
  hashScope,
  StateTransactionError,
  type SessionState,
  type SpecJson,
} from "../../shared/types"

let root: string
const featureRel = "specs/001-demo"
const archiveRel = "archive/2026-10-22-001-demo"
const sessionRel = ".opencode/spec-memory/session.json"

function makeSpec(overrides: Partial<SpecJson> = {}): SpecJson {
  return {
    feature_name: "demo",
    feature_number: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    phase: "complete",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    ready_for_implementation: true,
    active_delta: null,
    converged: true,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    command: "test",
    phase: "complete",
    featureDir: "001-demo",
    featureNumber: 1,
    featureName: "demo",
    nextStep: "/archive",
    lastResult: null,
    history: ["one", "two"],
    ...overrides,
  }
}

async function pathExists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, ...rel.split("/"))).then(() => true).catch(() => false)
}

async function writeJson(rel: string, value: unknown): Promise<void> {
  const abs = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify(value, null, 2), "utf-8")
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(root, ...rel.split("/")), "utf-8")) as T
}

beforeEach(async () => {
  root = await createTempWorktree()
  await fs.mkdir(path.join(root, featureRel), { recursive: true })
  await fs.writeFile(path.join(root, featureRel, "spec.md"), "# Demo\n", "utf-8")
  await writeJson(`${featureRel}/spec.json`, makeSpec())
  await writeJson(sessionRel, makeSession())
})

afterEach(async () => {
  vi.restoreAllMocks()
  await destroyTempWorktree(root)
})

describe("state plan and apply", () => {
  it("freezes the plan and hashes the source and the predicted target", async () => {
    const plan = await createStatePlan({
      root,
      scope: [featureRel, archiveRel, sessionRel],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
      now: new Date("2026-10-22T00:00:00.000Z"),
      planId: "plan-freeze",
    })

    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.operations)).toBe(true)
    expect(plan.baseHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.expectedHash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.baseHash).not.toBe(plan.expectedHash)
    expect(plan.scope).toContain(featureRel)
    expect(plan.scope).toContain(archiveRel)
  })

  it("renames a feature once and writes the archived metadata and cleared session", async () => {
    const spec = makeSpec()
    const session = makeSession()
    const plan = await createStatePlan({
      root,
      scope: [featureRel, archiveRel, sessionRel],
      preconditions: [
        { path: featureRel, kind: "dir", sha256: await hashPathTree(root, featureRel) },
        { path: archiveRel, kind: "absent" },
        { path: sessionRel, kind: "file", sha256: await hashPathTree(root, sessionRel) },
      ],
      operations: [
        { kind: "rename-dir", from: featureRel, to: archiveRel },
        {
          kind: "write-spec-json",
          featureDir: archiveRel,
          data: { ...spec, archived_at: "2026-10-22T00:00:00.000Z" },
        },
        {
          kind: "write-session",
          data: { ...session, featureDir: null, phase: "spec", nextStep: "/spec <description>", history: [] },
        },
      ],
      now: new Date("2026-10-22T00:00:00.000Z"),
      planId: "plan-archive",
    })

    const result = await applyStatePlan(root, plan)
    expect(result.planId).toBe("plan-archive")
    expect(await pathExists(featureRel)).toBe(false)
    expect(await pathExists(`${archiveRel}/spec.md`)).toBe(true)

    const archived = await readJson<SpecJson>(`${archiveRel}/spec.json`)
    expect(archived.archived_at).toBe("2026-10-22T00:00:00.000Z")
    expect(archived.updated_at).toBe("2026-10-22T00:00:00.000Z")
    expect(await pathExists(`${archiveRel}/spec.json.sha256`)).toBe(true)

    const nextSession = await readJson<SessionState>(sessionRel)
    expect(nextSession.featureDir).toBeNull()
    expect(nextSession.phase).toBe("spec")
    expect(nextSession.history).toEqual([])

    const transactions = await fs.readdir(path.join(root, ".opencode", "transactions")).catch(() => [])
    expect(transactions).toEqual([])
  })

  it("refuses a plan when the scoped base changed", async () => {
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })
    await writeJson(sessionRel, makeSession({ command: "changed elsewhere" }))

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "STALE_BASE" })
    const session = await readJson<SessionState>(sessionRel)
    expect(session.command).toBe("changed elsewhere")
  })

  it("refuses a plan when a content precondition changed", async () => {
    const sessionHash = await hashPathTree(root, sessionRel)
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [{ path: sessionRel, kind: "file", sha256: sessionHash }],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })
    await writeJson(sessionRel, makeSession({ command: "changed elsewhere" }))

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "PRECONDITION" })
  })

  it("refuses a rename when the target appears after the plan was built", async () => {
    const plan = await createStatePlan({
      root,
      scope: [featureRel, archiveRel],
      preconditions: [{ path: archiveRel, kind: "absent" }],
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    })
    await fs.mkdir(path.join(root, archiveRel), { recursive: true })

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "TARGET_EXISTS" })
    expect(await pathExists(featureRel)).toBe(true)
  })

  it("rejects a plan whose hash does not match its content", async () => {
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })
    const tampered = { ...plan, planId: "tampered" }

    await expect(applyStatePlan(root, tampered)).rejects.toMatchObject({ code: "PLAN_INVALID" })
  })

  it("rejects traversal and absolute paths before writing anything", async () => {
    await expect(createStatePlan({
      root,
      scope: ["../escape"],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession() }],
    })).rejects.toThrow(/unsafe state path/)

    await expect(createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-spec-json", featureDir: "../escape", data: makeSpec() }],
    })).rejects.toThrow(/unsafe state path/)
  })

  it("rolls back the rename and restores the original metadata when a write fails", async () => {
    const originalSpec = await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")
    const originalSession = await fs.readFile(path.join(root, sessionRel), "utf-8")
    const plan = await createStatePlan({
      root,
      scope: [featureRel, archiveRel, sessionRel],
      preconditions: [
        { path: featureRel, kind: "dir", sha256: await hashPathTree(root, featureRel) },
        { path: archiveRel, kind: "absent" },
      ],
      operations: [
        { kind: "rename-dir", from: featureRel, to: archiveRel },
        {
          kind: "write-spec-json",
          featureDir: archiveRel,
          data: { ...makeSpec(), archived_at: "2026-10-22T00:00:00.000Z" },
        },
        { kind: "write-session", data: makeSession({ featureDir: null, phase: "spec" }) },
      ],
    })

    const originalRename = fs.rename.bind(fs)
    let injected = false
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const sourceName = path.basename(String(from))
      if (!injected && sourceName.startsWith("spec.json.") && sourceName.endsWith(".tmp") && path.basename(String(to)) === "spec.json") {
        injected = true
        throw new Error("injected spec write failure")
      }
      return originalRename(from, to)
    })

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "APPLY_FAILED" })
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(false)
    expect(await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")).toBe(originalSpec)
    expect(await fs.readFile(path.join(root, sessionRel), "utf-8")).toBe(originalSession)
    const transactions = await fs.readdir(path.join(root, ".opencode", "transactions")).catch(() => [])
    expect(transactions).toEqual([])
  })

  it("matches the planned hash across a deterministic random sequence of state writes", async () => {
    let seed = 123456789
    const random = (): number => {
      seed = (1664525 * seed + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const configRel = ".opencode/spec-memory/config.json"

    for (let index = 0; index < 12; index++) {
      const history = Array.from({ length: Math.floor(random() * 24) }, (_, item) => `entry-${index}-${item}`)
      const operations: Parameters<typeof createStatePlan>[0]["operations"] = [{
        kind: "write-session",
        data: makeSession({ command: `command-${index}`, history }),
      }]
      if (random() > 0.4) {
        operations.push({
          kind: "write-spec-json",
          featureDir: featureRel,
          data: makeSpec({ phase: random() > 0.5 ? "impl" : "complete", converged: random() > 0.5 }),
        })
      }
      if (random() > 0.5) {
        operations.push({
          kind: "write-config",
          data: {
            defaultTechStack: random() > 0.5 ? "typescript" : null,
            lastUsedLanguage: random() > 0.5 ? "en" : null,
            expressMode: random() > 0.5,
            autoVersioning: false,
            preferences: { iteration: String(index) },
          },
        })
      }

      const scope = [sessionRel, featureRel, configRel]
      const plan = await createStatePlan({ root, scope, preconditions: [], operations })
      await applyStatePlan(root, plan)
      expect(await hashScope(root, plan.scope)).toBe(plan.expectedHash)
    }
  })

  it("serializes two concurrent applies so only one can consume the same base", async () => {
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })

    const results = await Promise.allSettled([
      applyStatePlan(root, plan),
      applyStatePlan(root, plan),
    ])
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "STALE_BASE" })

    const session = await readJson<SessionState>(sessionRel)
    expect(session.command).toBe("next")
    const transactions = await fs.readdir(path.join(root, ".opencode", "transactions")).catch(() => [])
    expect(transactions).toEqual([])
  })

  it("keeps the error class and code visible to the caller", async () => {
    const plan = await createStatePlan({
      root,
      scope: ["specs/missing"],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: "specs/missing", to: "archive/missing" }],
    }).catch((err) => err)
    expect(plan).toBeInstanceOf(StateTransactionError)
    expect(plan.code).toBe("PRECONDITION")
  })
})
