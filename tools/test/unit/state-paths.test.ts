import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  assertSafeRelativePath,
  computePlanHash,
  hashPathTree,
  hashScope,
  isExcludedStatePath,
  normalizeScope,
  type StatePlan,
} from "../../shared/types"

let root: string

beforeEach(async () => {
  root = await createTempWorktree()
})

afterEach(async () => {
  await destroyTempWorktree(root)
})

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

function plan(order: "forward" | "reverse"): StatePlan {
  const operation = {
    kind: "write-session" as const,
    data: {
      command: null,
      phase: "spec" as const,
      featureDir: null,
      featureNumber: null,
      featureName: null,
      nextStep: null,
      lastResult: null,
      history: [],
    },
  }
  const values = {
    format: 1 as const,
    planId: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: ["a", "b"],
    preconditions: [],
    operations: [operation],
    baseHash: "0".repeat(64),
    expectedHash: "1".repeat(64),
    planHash: "2".repeat(64),
  }
  if (order === "forward") return { ...values }
  return {
    planHash: values.planHash,
    expectedHash: values.expectedHash,
    baseHash: values.baseHash,
    operations: values.operations,
    preconditions: values.preconditions,
    scope: values.scope,
    createdAt: values.createdAt,
    planId: values.planId,
    format: values.format,
  }
}

describe("state path validation", () => {
  it.each([
    "../escape",
    "a/../../escape",
    "/absolute",
    "\\absolute",
    "C:\\absolute",
    "C:/absolute",
    "a\\b",
    "a//b",
    "./a",
    "a/./b",
    "a/..",
    "",
    "a/\0b",
  ])("rejects %j", (candidate) => {
    expect(() => assertSafeRelativePath(candidate)).toThrow(/unsafe state path/)
  })

  it.each([
    "a",
    "a/b",
    ".opencode/spec-memory/session.json",
    "specs/001-demo",
    "a-b_c.d",
  ])("accepts %j", (candidate) => {
    expect(() => assertSafeRelativePath(candidate)).not.toThrow()
  })

  it("normalizes scope by sorting, deduplicating and dropping nested paths", () => {
    expect(normalizeScope(["b", "a/c", "a", "a/b", "b"])).toEqual(["a", "b"])
  })

  it("names the transient paths that never enter a hash", () => {
    expect(isExcludedStatePath(".opencode/backups/a")).toBe(true)
    expect(isExcludedStatePath(".opencode/snapshots/a")).toBe(true)
    expect(isExcludedStatePath(".opencode/transactions/a")).toBe(true)
    expect(isExcludedStatePath("specs/001-demo/spec.json.sha256")).toBe(true)
    expect(isExcludedStatePath("specs/001-demo/spec.json.lock")).toBe(true)
    expect(isExcludedStatePath("specs/001-demo/spec.json.tmp")).toBe(true)
    expect(isExcludedStatePath("specs/001-demo/spec.json.bak")).toBe(true)
    expect(isExcludedStatePath("specs/001-demo/spec.json")).toBe(false)
  })
})

describe("state hashes", () => {
  it("is deterministic, order independent and sensitive to content", async () => {
    await write("a/one.txt", "one")
    await write("a/two.txt", "two")
    await write("b.txt", "bee")

    const first = await hashScope(root, ["a", "b.txt"])
    const reordered = await hashScope(root, ["b.txt", "a", "a"])
    expect(reordered).toBe(first)

    const before = await hashPathTree(root, "a")
    await write("a/three.txt", "three")
    const after = await hashPathTree(root, "a")
    expect(after).not.toBe(before)

    await write("a/one.txt", "changed")
    expect(await hashPathTree(root, "a")).not.toBe(after)
  })

  it("ignores backups, snapshots, transactions, sidecars, locks and temp files", async () => {
    await write(".opencode/spec-memory/session.json", "{}")
    await write("specs/001-demo/spec.json", "{}")
    const before = await hashScope(root, [".opencode", "specs/001-demo"])

    await write(".opencode/backups/session.json.1.bak", "old")
    await write(".opencode/snapshots/snap/manifest.json", "{}")
    await write(".opencode/transactions/tx/journal.json", "{}")
    await write("specs/001-demo/spec.json.sha256", "checksum")
    await write("specs/001-demo/spec.json.lock/info", "lock")
    await write("specs/001-demo/spec.json.tmp", "temp")
    await write("specs/001-demo/spec.json.1.bak", "backup")

    expect(await hashScope(root, [".opencode", "specs/001-demo"])).toBe(before)
  })

  it("reports absent for a path that does not exist", async () => {
    expect(await hashPathTree(root, "missing")).toBe("absent")
  })
})

describe("plan hashes", () => {
  it("does not depend on object key insertion order", () => {
    expect(computePlanHash(plan("forward"))).toBe(computePlanHash(plan("reverse")))
  })

  it("changes when any committed field changes", () => {
    const original = plan("forward")
    const changedScope = { ...original, scope: ["a", "c"] }
    const changedOperations = {
      ...original,
      operations: [{ kind: "rename-dir" as const, from: "a", to: "c" }],
    }
    const changedPlanId = { ...original, planId: "other" }

    expect(computePlanHash(changedScope)).not.toBe(computePlanHash(original))
    expect(computePlanHash(changedOperations)).not.toBe(computePlanHash(original))
    expect(computePlanHash(changedPlanId)).not.toBe(computePlanHash(original))
  })
})
