import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  assertNoSymlinkParents,
  assertSafeRelativePath,
  canonicalJson,
  clearTransaction,
  computePlanHash,
  hashPathTree,
  hashScope,
  isExcludedStatePath,
  journalPath,
  listTransactionIds,
  normalizeScope,
  readJournal,
  readPathTree,
  resolveStatePath,
  sha256,
  transactionDirPath,
  writeJournal,
  type StateJournal,
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

function journal(overrides: Partial<StateJournal> = {}): StateJournal {
  return {
    format: 1,
    txId: "tx-test",
    planId: "plan-test",
    planHash: "0".repeat(64),
    baseHash: "1".repeat(64),
    expectedHash: "2".repeat(64),
    state: "prepared",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pid: process.pid,
    operations: [{ kind: "write-session", data: {
      command: null,
      phase: "spec",
      featureDir: null,
      featureNumber: null,
      featureName: null,
      nextStep: null,
      lastResult: null,
      history: [],
    } }],
    backups: [],
    ...overrides,
  }
}

describe("canonical serialization", () => {
  it("serializes primitives and arrays without changing values", () => {
    expect(canonicalJson(null)).toBe("null")
    expect(canonicalJson(true)).toBe("true")
    expect(canonicalJson(42)).toBe("42")
    expect(canonicalJson("text")).toBe('"text"')
    expect(canonicalJson([1, "two", null])).toBe('[1,"two",null]')
  })

  it("sorts object keys and omits undefined properties", () => {
    expect(canonicalJson({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}')
    expect(canonicalJson({ b: [true, null], a: "x" })).toBe('{"a":"x","b":[true,null]}')
  })

  it("hashes empty input with the known SHA-256 digest", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })
})

describe("state path resolution", () => {
  it("resolves a safe nested path under the root", () => {
    expect(resolveStatePath(root, "specs/001-demo/spec.json"))
      .toBe(path.join(root, "specs", "001-demo", "spec.json"))
  })

  it("rejects traversal before resolving", () => {
    expect(() => resolveStatePath(root, "../escape")).toThrow(/unsafe state path/)
  })

  it("rejects a symlink anywhere in the parent chain", async () => {
    await write("real/child.txt", "value")
    await fs.symlink(path.join(root, "real"), path.join(root, "linked"), "dir")
    await expect(assertNoSymlinkParents(root, "linked/child.txt")).rejects.toThrow(/unsafe state path/)
  })

  it("rejects a regular file used as a parent", async () => {
    await write("plain.txt", "value")
    await expect(assertNoSymlinkParents(root, "plain.txt/child")).rejects.toThrow(/unsafe state path/)
  })

  it("stops at the first missing parent", async () => {
    await expect(assertNoSymlinkParents(root, "missing/child/grandchild")).resolves.toBeUndefined()
  })
})

describe("path tree reads", () => {
  it("returns a hash for a file and sorted entries for a directory", async () => {
    await write("tree/b.txt", "b")
    await write("tree/a.txt", "a")
    await write("tree/spec.json.sha256", "checksum")
    const file = await readPathTree(root, "tree/a.txt")
    expect(file).toEqual({ kind: "file", sha256: sha256(await fs.readFile(path.join(root, "tree/a.txt"))) })
    const dir = await readPathTree(root, "tree")
    expect(dir.kind).toBe("dir")
    if (dir.kind === "dir") {
      expect(dir.entries.map((entry) => entry.path)).toEqual(["tree/a.txt", "tree/b.txt"])
    }
  })

  it("rejects a symlink leaf", async () => {
    await write("real.txt", "value")
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "link.txt"))
    await expect(readPathTree(root, "link.txt")).rejects.toThrow(/unsafe state path/)
  })

  it("recognizes exact and nested transient directories", () => {
    expect(isExcludedStatePath(".opencode/backups")).toBe(true)
    expect(isExcludedStatePath(".opencode/backups/session.json.1.bak")).toBe(true)
    expect(isExcludedStatePath(".opencode/snapshots")).toBe(true)
    expect(isExcludedStatePath(".opencode/transactions")).toBe(true)
    expect(isExcludedStatePath("backups/session.json")).toBe(false)
  })
})

describe("transaction layout", () => {
  it("rejects transaction identifiers with separators", () => {
    expect(() => transactionDirPath(root, "../escape")).toThrow(/unsafe transaction id/)
    expect(() => transactionDirPath(root, "tx/child")).toThrow(/unsafe transaction id/)
  })

  it("round trips a journal through the transaction directory", async () => {
    const value = journal()
    await writeJournal(root, value)
    expect(await readJournal(root, value.txId)).toEqual(value)
    expect(journalPath(root, value.txId)).toContain(path.join("tx-test", "journal.json"))
  })

  it("reads a BOM prefixed journal", async () => {
    const value = journal()
    await fs.mkdir(path.dirname(journalPath(root, value.txId)), { recursive: true })
    await fs.writeFile(journalPath(root, value.txId), "\uFEFF" + JSON.stringify(value), "utf-8")
    expect(await readJournal(root, value.txId)).toEqual(value)
  })

  it("returns null for malformed or schema invalid journals", async () => {
    await fs.mkdir(path.dirname(journalPath(root, "tx-bad")), { recursive: true })
    await fs.writeFile(journalPath(root, "tx-bad"), "{not json", "utf-8")
    expect(await readJournal(root, "tx-bad")).toBeNull()
    await fs.writeFile(journalPath(root, "tx-bad"), JSON.stringify({ format: 1 }), "utf-8")
    expect(await readJournal(root, "tx-bad")).toBeNull()
  })

  it("lists only transaction directories and ignores the state lock", async () => {
    await fs.mkdir(transactionDirPath(root, "tx-b"), { recursive: true })
    await fs.mkdir(transactionDirPath(root, "tx-a"), { recursive: true })
    await fs.mkdir(path.join(root, ".opencode", "transactions", "state.lock"), { recursive: true })
    await fs.writeFile(path.join(root, ".opencode", "transactions", "loose.txt"), "x", "utf-8")
    expect(await listTransactionIds(root)).toEqual(["tx-a", "tx-b"])
  })

  it("clears one transaction without touching its siblings", async () => {
    await fs.mkdir(transactionDirPath(root, "tx-a"), { recursive: true })
    await fs.mkdir(transactionDirPath(root, "tx-b"), { recursive: true })
    await clearTransaction(root, "tx-a")
    expect(await listTransactionIds(root)).toEqual(["tx-b"])
  })
})
