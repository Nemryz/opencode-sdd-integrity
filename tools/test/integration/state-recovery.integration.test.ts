import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  recoverStateTransactions,
  sha256,
  toPosix,
  transactionBackupPath,
  transactionDirPath,
  transactionsDirPath,
  writeJournal,
  type SpecJson,
  type StateJournal,
} from "../../shared/types"

let root: string
const featureRel = "specs/001-demo"
const archiveRel = "archive/2026-10-22-001-demo"
const specRel = `${featureRel}/spec.json`

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

async function pathExists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, ...rel.split("/"))).then(() => true).catch(() => false)
}

async function absolutePathExists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true).catch(() => false)
}

function journal(overrides: Partial<StateJournal> = {}): StateJournal {
  return {
    format: 1,
    txId: "tx-recovery",
    planId: "plan-recovery",
    planHash: "0".repeat(64),
    baseHash: "0".repeat(64),
    expectedHash: "0".repeat(64),
    state: "prepared",
    startedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    pid: process.pid,
    operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    backups: [],
    ...overrides,
  }
}

beforeEach(async () => {
  root = await createTempWorktree()
  await fs.mkdir(path.join(root, featureRel), { recursive: true })
  await fs.writeFile(path.join(root, featureRel, "spec.md"), "# Demo\n", "utf-8")
  await fs.writeFile(path.join(root, specRel), JSON.stringify(makeSpec(), null, 2), "utf-8")
})

afterEach(async () => {
  await destroyTempWorktree(root)
})

describe("state transaction recovery", () => {
  it("reverses an applied rename and restores the backup from an applying journal", async () => {
    const originalSpec = await fs.readFile(path.join(root, specRel), "utf-8")
    await fs.mkdir(path.join(root, "archive"), { recursive: true })
    await fs.rename(path.join(root, featureRel), path.join(root, archiveRel))
    const archivedSpec = makeSpec({ archived_at: "2026-10-22T00:00:00.000Z" })
    await fs.writeFile(path.join(root, archiveRel, "spec.json"), JSON.stringify(archivedSpec, null, 2), "utf-8")

    const backupRel = toPosix(path.relative(root, transactionBackupPath(root, "tx-recovery", `${archiveRel}/spec.json`)))
    await fs.mkdir(path.dirname(path.join(root, backupRel)), { recursive: true })
    await fs.writeFile(path.join(root, backupRel), originalSpec, "utf-8")

    await writeJournal(root, journal({
      state: "applying",
      operations: [
        { kind: "rename-dir", from: featureRel, to: archiveRel },
        { kind: "write-spec-json", featureDir: archiveRel, data: archivedSpec },
      ],
      backups: [{
        path: `${archiveRel}/spec.json`,
        kind: "file",
        backupPath: backupRel,
        sha256: sha256(originalSpec),
      }],
    }))

    const result = await recoverStateTransactions(root)
    expect(result.recovered).toContain("tx-recovery")
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(false)
    expect(await fs.readFile(path.join(root, specRel), "utf-8")).toBe(originalSpec)
    expect(await pathExists(`.opencode/transactions/tx-recovery`)).toBe(false)
  })

  it("leaves the source and a foreign target in place when both exist", async () => {
    await fs.mkdir(path.join(root, archiveRel), { recursive: true })
    await fs.writeFile(path.join(root, archiveRel, "foreign.txt"), "other", "utf-8")
    await writeJournal(root, journal({ state: "applying" }))

    const result = await recoverStateTransactions(root)
    expect(result.recovered).toContain("tx-recovery")
    expect(await pathExists(featureRel)).toBe(true)
    expect(await pathExists(archiveRel)).toBe(true)
    expect(await fs.readFile(path.join(root, featureRel, "spec.md"), "utf-8")).toBe("# Demo\n")
    expect(await fs.readFile(path.join(root, archiveRel, "foreign.txt"), "utf-8")).toBe("other")
    expect(await pathExists(".opencode/transactions/tx-recovery")).toBe(false)
  })

  it("only clears a committed journal and leaves the applied state alone", async () => {
    await fs.mkdir(path.join(root, "archive"), { recursive: true })
    await fs.rename(path.join(root, featureRel), path.join(root, archiveRel))
    await writeJournal(root, journal({
      state: "committed",
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    }))

    await recoverStateTransactions(root)
    expect(await pathExists(featureRel)).toBe(false)
    expect(await pathExists(archiveRel)).toBe(true)
    expect(await absolutePathExists(transactionDirPath(root, "tx-recovery"))).toBe(false)
  })

  it("keeps a failed rollback visible instead of hiding it", async () => {
    await writeJournal(root, journal({
      state: "rollback-failed",
      error: "manual repair needed",
      operations: [{ kind: "rename-dir", from: featureRel, to: archiveRel }],
    }))

    await expect(recoverStateTransactions(root)).rejects.toMatchObject({ code: "ROLLBACK_FAILED" })
    expect(await absolutePathExists(transactionDirPath(root, "tx-recovery"))).toBe(true)
  })

  it("removes a transaction directory that has no readable journal", async () => {
    await fs.mkdir(transactionDirPath(root, "tx-empty"), { recursive: true })
    const result = await recoverStateTransactions(root)
    expect(result.recovered).toEqual([])
    expect(await absolutePathExists(transactionDirPath(root, "tx-empty"))).toBe(false)
    expect(await absolutePathExists(transactionsDirPath(root))).toBe(true)
  })
})
