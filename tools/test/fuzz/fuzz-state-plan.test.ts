import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  StateJournalSchema,
  StateOperationSchema,
  StatePlanSchema,
  createStatePlan,
  normalizeScope,
} from "../../shared/types"

let root: string

const session = {
  command: null,
  phase: "spec" as const,
  featureDir: null,
  featureNumber: null,
  featureName: null,
  nextStep: null,
  lastResult: null,
  history: [],
}

function validPlan() {
  return {
    format: 1 as const,
    planId: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: ["a"],
    preconditions: [],
    operations: [{ kind: "write-session" as const, data: session }],
    baseHash: "0".repeat(64),
    expectedHash: "1".repeat(64),
    planHash: "2".repeat(64),
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fuzz-state-plan-"))
  await fs.mkdir(path.join(root, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("Fuzz: state plan schema", () => {
  it("accepts a complete plan", () => {
    expect(StatePlanSchema.safeParse(validPlan()).success).toBe(true)
  })

  it.each([
    ["missing plan hash", { ...validPlan(), planHash: undefined }],
    ["short base hash", { ...validPlan(), baseHash: "0" }],
    ["empty plan id", { ...validPlan(), planId: "" }],
    ["wrong format", { ...validPlan(), format: 2 }],
    ["null scope", { ...validPlan(), scope: null }],
    ["string scope", { ...validPlan(), scope: "a" }],
    ["unknown operation", { ...validPlan(), operations: [{ kind: "copy-dir" }] }],
    ["null operation", { ...validPlan(), operations: [null] }],
    ["unknown precondition", { ...validPlan(), preconditions: [{ path: "a", kind: "symlink" }] }],
  ])("rejects %s", (_name, candidate) => {
    expect(StatePlanSchema.safeParse(candidate).success).toBe(false)
  })

  it.each([
    ["rename without target", { kind: "rename-dir", from: "a" }],
    ["rename with null paths", { kind: "rename-dir", from: null, to: null }],
    ["session with wrong history", { kind: "write-session", data: { ...session, history: "one" } }],
    ["spec with wrong phase", { kind: "write-spec-json", featureDir: "specs/001", data: { phase: "done" } }],
    ["config with wrong preferences", { kind: "write-config", data: { preferences: [] } }],
  ])("rejects operation: %s", (_name, candidate) => {
    expect(StateOperationSchema.safeParse(candidate).success).toBe(false)
  })

  it.each([
    ["unknown state", { ...validPlan(), state: "done", txId: "tx", planId: "plan", planHash: "0".repeat(64), startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", pid: 1, backups: [] }],
    ["wrong backup kind", { ...validPlan(), state: "prepared", txId: "tx", planId: "plan", planHash: "0".repeat(64), startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", pid: 1, backups: [{ path: "a", kind: "dir" }] }],
  ])("rejects journal: %s", (_name, candidate) => {
    expect(StateJournalSchema.safeParse(candidate).success).toBe(false)
  })
})

describe("Fuzz: state plan builder", () => {
  it("normalizes duplicate and nested scopes", () => {
    expect(normalizeScope(["a", "a/b", "a", "c"])).toEqual(["a", "c"])
  })

  it.each([
    "../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a//b",
  ])("rejects hostile scope %j before writing", async (scope) => {
    await expect(createStatePlan({
      root,
      scope: [scope],
      preconditions: [],
      operations: [{ kind: "write-session", data: session }],
    })).rejects.toThrow(/unsafe state path/)
    await expect(fs.access(path.join(root, ".opencode", "spec-memory", "session.json"))).rejects.toThrow()
  })

  it.each([
    { kind: "copy-dir", from: "a", to: "b" },
    { kind: "write-session" },
    { kind: "write-session", data: null },
    null,
    "write-session",
  ])("rejects malformed operation %j without writing", async (operation) => {
    await expect(createStatePlan({
      root,
      scope: [".opencode/spec-memory/session.json"],
      preconditions: [],
      operations: [operation as never],
    })).rejects.toThrow()
    await expect(fs.access(path.join(root, ".opencode", "spec-memory", "session.json"))).rejects.toThrow()
  })
})
