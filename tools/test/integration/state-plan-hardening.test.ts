import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  applyStatePlan,
  createStatePlan,
  hashScope,
  hashVirtualScope,
  simulateExpectedState,
  stateWritePath,
  validateStatePlan,
  type SDDConfig,
  type SessionState,
  type SpecJson,
} from "../../shared/types"

let root: string
const featureRel = "specs/001-demo"
const archiveRel = "archive/2026-10-22-001-demo"
const sessionRel = ".opencode/spec-memory/session.json"
const configRel = ".opencode/spec-memory/config.json"

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
    history: ["one"],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SDDConfig> = {}): SDDConfig {
  return {
    defaultTechStack: null,
    lastUsedLanguage: null,
    expressMode: false,
    autoVersioning: false,
    preferences: {},
    ...overrides,
  }
}

async function write(rel: string, content = "{}"): Promise<void> {
  const abs = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

beforeEach(async () => {
  root = await createTempWorktree()
})

afterEach(async () => {
  await destroyTempWorktree(root)
})

describe("state plan hardening", () => {
  it("freezes nested operation data and array members", async () => {
    await write(sessionRel, JSON.stringify(makeSession()))
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession({ history: ["one", "two"] }) }],
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.operations)).toBe(true)
    expect(Object.isFrozen(plan.operations[0])).toBe(true)
    expect(Object.isFrozen((plan.operations[0] as { data: SessionState }).data)).toBe(true)
    expect(Object.isFrozen((plan.operations[0] as { data: SessionState }).data.history)).toBe(true)
  })

  it("rejects an operation that does not match the schema", async () => {
    await expect(createStatePlan({
      root,
      scope: ["specs/x"],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: "", to: "archive/x" }],
    })).rejects.toMatchObject({ code: "PLAN_INVALID" })
  })

  it("rejects a config operation with invalid data", async () => {
    await expect(createStatePlan({
      root,
      scope: [configRel],
      preconditions: [],
      operations: [{
        kind: "write-config",
        data: { ...makeConfig(), expressMode: "yes" } as unknown as SDDConfig,
      }],
    })).rejects.toMatchObject({ code: "PLAN_INVALID" })
  })

  it("rejects a rename whose source and target are identical", async () => {
    await write(`${featureRel}/spec.md`, "# Demo")
    await expect(createStatePlan({
      root,
      scope: [featureRel],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: featureRel, to: featureRel }],
    })).rejects.toMatchObject({ code: "PLAN_INVALID" })
  })

  it.each([
    ["source inside target", "archive/root/source", "archive/root"],
    ["target inside source", "specs/001-demo", "specs/001-demo/archive"],
  ])("rejects a rename with %s", async (_label, from, to) => {
    await expect(createStatePlan({
      root,
      scope: [from, to],
      preconditions: [],
      operations: [{ kind: "rename-dir", from, to }],
    })).rejects.toMatchObject({ code: "PLAN_INVALID" })
  })

  it("rejects a rename source that is a regular file", async () => {
    await write("specs/file.txt", "x")
    await expect(createStatePlan({
      root,
      scope: ["specs/file.txt", "archive/file.txt"],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: "specs/file.txt", to: "archive/file.txt" }],
    })).rejects.toMatchObject({ code: "PRECONDITION" })
  })

  it("rejects a rename target that already exists", async () => {
    await write(`${featureRel}/spec.md`, "# Demo")
    await fs.mkdir(path.join(root, archiveRel), { recursive: true })
    await expect(createStatePlan({
      root,
      scope: [featureRel, archiveRel],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    })).rejects.toMatchObject({ code: "TARGET_EXISTS" })
  })

  it("rejects a state file whose path is occupied by a directory", async () => {
    await fs.mkdir(path.join(root, sessionRel), { recursive: true })
    await expect(createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession() }],
    })).rejects.toMatchObject({ code: "TARGET_EXISTS" })
  })

  it("rejects a precondition with the wrong path kind", async () => {
    await write(sessionRel, JSON.stringify(makeSession()))
    await expect(createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [{ path: sessionRel, kind: "dir" }],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })).rejects.toMatchObject({ code: "PRECONDITION" })
  })

  it("rejects a precondition with a stale content hash", async () => {
    await write(sessionRel, JSON.stringify(makeSession()))
    await expect(createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [{ path: sessionRel, kind: "file", sha256: "0".repeat(64) }],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })).rejects.toMatchObject({ code: "PRECONDITION" })
  })

  it("adds config and feature writes to the scope and matches the applied hash", async () => {
    await write(`${featureRel}/spec.json`, JSON.stringify(makeSpec()))
    const plan = await createStatePlan({
      root,
      scope: [featureRel],
      preconditions: [],
      operations: [
        { kind: "write-spec-json", featureDir: featureRel, data: makeSpec({ phase: "impl" }) },
        { kind: "write-config", data: makeConfig({ lastUsedLanguage: "es" }) },
      ],
      now: new Date("2026-01-03T00:00:00.000Z"),
    })
    expect(plan.scope).toContain(featureRel)
    expect(plan.scope).toContain(configRel)
    expect(plan.scope).not.toContain(`${featureRel}/spec.json`)
    await applyStatePlan(root, plan)
    expect(await hashScope(root, plan.scope)).toBe(plan.expectedHash)
  })

  it("moves nested files and empty directories to the virtual target", async () => {
    await write(`${featureRel}/spec.md`, "# Demo")
    await fs.mkdir(path.join(root, featureRel, "empty"), { recursive: true })
    const plan = await createStatePlan({
      root,
      scope: [featureRel, archiveRel],
      preconditions: [],
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    })
    await applyStatePlan(root, plan)
    expect((await fs.stat(path.join(root, archiveRel, "empty"))).isDirectory()).toBe(true)
    expect(await hashScope(root, plan.scope)).toBe(plan.expectedHash)
  })

  it("detects a virtual rename target that already has entries", async () => {
    await write(`${featureRel}/spec.md`, "# Demo")
    await write(`${archiveRel}/foreign.txt`, "other")
    await expect(simulateExpectedState(
      root,
      [featureRel, archiveRel],
      [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    )).rejects.toMatchObject({ code: "TARGET_EXISTS" })
  })

  it("detects a virtual write that collides with a directory", async () => {
    await write(`${sessionRel}/child`, "value")
    await expect(simulateExpectedState(
      root,
      [sessionRel],
      [{ kind: "write-session", data: makeSession() }],
    )).rejects.toMatchObject({ code: "TARGET_EXISTS" })
  })

  it("hashes virtual scopes independent of order and duplicates", async () => {
    await write("a.txt", "a")
    await write("b.txt", "b")
    const { virtual } = await simulateExpectedState(root, ["a.txt", "b.txt"], [])
    expect(hashVirtualScope(virtual, ["b.txt", "a.txt", "a.txt"]))
      .toBe(hashVirtualScope(virtual, ["a.txt", "b.txt"]))
  })

  it("validates the plan shape and its content hash", async () => {
    await write(sessionRel, JSON.stringify(makeSession()))
    const plan = await createStatePlan({
      root,
      scope: [sessionRel],
      preconditions: [],
      operations: [{ kind: "write-session", data: makeSession({ command: "next" }) }],
    })
    expect(validateStatePlan(plan)).toEqual(plan)
    expect(() => validateStatePlan({ ...plan, format: 2 } as never)).toThrow(/invalid state plan/)
    expect(() => validateStatePlan({ ...plan, planHash: "f".repeat(64) })).toThrow(/hash does not match/)
  })

  it("maps every write operation to its concrete file", () => {
    expect(stateWritePath({ kind: "write-spec-json", featureDir: featureRel, data: makeSpec() }))
      .toBe(`${featureRel}/spec.json`)
    expect(stateWritePath({ kind: "write-session", data: makeSession() })).toBe(sessionRel)
    expect(stateWritePath({ kind: "write-config", data: makeConfig() })).toBe(configRel)
    expect(stateWritePath({ kind: "rename-dir", from: featureRel, to: archiveRel })).toBeNull()
  })
})
