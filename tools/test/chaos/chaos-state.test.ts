import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  applyStatePlan,
  createStatePlan,
  hashPathTree,
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

async function writeJson(rel: string, value: unknown): Promise<void> {
  const abs = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify(value, null, 2), "utf-8")
}

async function pathExists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, ...rel.split("/"))).then(() => true).catch(() => false)
}

async function archivePlan() {
  return createStatePlan({
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

describe("chaos: state transaction failures", () => {
  it("rolls back the rename, the spec write and the session write when the session landing fails", async () => {
    const originalSpec = await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")
    const originalSession = await fs.readFile(path.join(root, sessionRel), "utf-8")
    const plan = await archivePlan()

    const originalRename = fs.rename.bind(fs)
    let injected = false
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const sourceName = path.basename(String(from))
      if (!injected && sourceName.startsWith("session.json.") && sourceName.endsWith(".tmp") && path.basename(String(to)) === "session.json") {
        injected = true
        throw new Error("injected session write failure")
      }
      return originalRename(from, to)
    })

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "APPLY_FAILED" })
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(false)
    expect(await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")).toBe(originalSpec)
    expect(await fs.readFile(path.join(root, sessionRel), "utf-8")).toBe(originalSession)
    expect(await fs.readdir(path.join(root, ".opencode", "transactions"))).toEqual([])
  })

  it("rolls back when the checksum sidecar cannot land after the spec write", async () => {
    const originalSpec = await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")
    const plan = await archivePlan()

    const originalRename = fs.rename.bind(fs)
    let injected = false
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const sourceName = path.basename(String(from))
      if (!injected && sourceName.startsWith("spec.json.sha256.") && sourceName.endsWith(".tmp") && path.basename(String(to)) === "spec.json.sha256") {
        injected = true
        throw new Error("injected checksum write failure")
      }
      return originalRename(from, to)
    })

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "APPLY_FAILED" })
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(false)
    expect(await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")).toBe(originalSpec)
    expect(await pathExists(`${featureRel}/spec.json.sha256`)).toBe(false)
  })

  it("leaves the state untouched when the journal itself cannot be written", async () => {
    const originalSpec = await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")
    const plan = await archivePlan()

    const originalRename = fs.rename.bind(fs)
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const sourceName = path.basename(String(from))
      if (sourceName.startsWith("journal.json.") && sourceName.endsWith(".tmp") && path.basename(String(to)) === "journal.json") {
        throw new Error("injected journal write failure")
      }
      return originalRename(from, to)
    })

    await expect(applyStatePlan(root, plan)).rejects.toMatchObject({ code: "APPLY_FAILED" })
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(false)
    expect(await fs.readFile(path.join(root, featureRel, "spec.json"), "utf-8")).toBe(originalSpec)
    expect(await fs.readdir(path.join(root, ".opencode", "transactions"))).toEqual([])
  })
})
