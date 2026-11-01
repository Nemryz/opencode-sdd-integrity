import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSandbox, destroySandbox } from "../../lab/core/sandbox"
import { readRegistry, writeRegistry } from "../../lab/core/registry"
import { pruneSandboxes } from "../../lab/core/prune"
import { labPaths } from "../../lab/core/home"
import { appendLabAudit, labAuditFile, readLabAudit } from "../../lab/core/audit"
import { makeAttackRepo, destroyAttackRepo, git } from "../helpers/corpus"
import type { LabSandbox } from "../../lab/core/types"

let repo: string | null = null

afterEach(async () => {
  if (repo) {
    await destroyAttackRepo(repo)
    repo = null
  }
})

describe("lab chaos torn writes", () => {
  it("rejects a half written registry with a readable error instead of trusting it", async () => {
    repo = await makeAttackRepo()
    const file = path.join(labPaths(repo).registry, "registry.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"version": 1, "sandboxes": [{"id": "broken', "utf-8")
    await expect(readRegistry(repo)).rejects.toThrow(/unreadable/)
  })

  it("ignores stale temporary artifacts from a crash and reads the healthy registry", async () => {
    repo = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    const layout = labPaths(repo)
    for (const dir of [layout.registry, layout.reports, layout.patches]) {
      await fs.writeFile(path.join(dir, `.crash.${process.pid}.tmp`), "garbage from a dead process", "utf-8")
    }
    const registry = await readRegistry(repo)
    expect(registry.sandboxes.map((entry) => entry.id)).toContain(sandbox.id)
    await destroySandbox(repo, { ...sandbox, status: "active" }, true)
  })
})

describe("lab chaos abandoned state", () => {
  it("marks a live registry entry whose worktree vanished as destroyed during prune", async () => {
    repo = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    await fs.rm(sandbox.sandboxRoot, { recursive: true, force: true })

    const result = await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: true })
    const candidate = result.candidates.find((entry) => entry.id === sandbox.id)
    expect(candidate).toMatchObject({ reason: "missing", action: "mark-destroyed" })
    expect(await readRegistry(repo).then((registry) => registry.sandboxes[0]?.status)).toBe("destroyed")
  })

  it.skipIf(process.platform === "win32")("lists a worktree that lost its registry entry as an orphan and never deletes it in a dry run", async () => {
    repo = await makeAttackRepo()
    const sandboxesRoot = labPaths(repo).sandboxes
    await fs.mkdir(sandboxesRoot, { recursive: true })
    git(repo, ["worktree", "add", "--detach", path.relative(repo, path.join(sandboxesRoot, "orphan"))])

    const result = await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: false })
    const orphan = result.candidates.find((entry) => entry.reason === "orphan-worktree")
    expect(orphan?.action).toBe("remove-worktree")
    const listed = await fs.readdir(sandboxesRoot)
    expect(listed).toContain("orphan")
  })
})

describe("lab chaos audit durability", () => {
  it("recreates the audit file after something deleted it and keeps the chronology ordered", async () => {
    repo = await makeAttackRepo()
    await appendLabAudit({
      kind: "lab_created",
      projectRoot: repo,
      when: new Date().toISOString(),
      sandboxId: "alpha",
      isolationProvider: "n/a",
      details: {},
    })
    const file = labAuditFile(repo)
    await fs.rm(file, { force: true })
    await appendLabAudit({
      kind: "lab_destroyed",
      projectRoot: repo,
      when: new Date().toISOString(),
      sandboxId: "alpha",
      isolationProvider: "n/a",
      details: {},
    })
    const records = await readLabAudit(repo)
    expect(records.map((record) => record.kind)).toEqual(["lab_destroyed"])
  })
})

describe("lab chaos registry race recovery", () => {
  it("lets a stale full snapshot writer replace the registry because the lock only serializes access", async () => {
    repo = await makeAttackRepo()
    const base: LabSandbox = {
      id: "seed",
      projectRoot: repo,
      repoRoot: repo,
      sandboxRoot: path.join(labPaths(repo).sandboxes, "seed"),
      adapter: "probe",
      baseCommit: "0".repeat(40),
      createdAt: new Date().toISOString(),
      status: "active",
      warnings: [],
    }
    await writeRegistry(repo, { version: 1, sandboxes: [base] })
    const stale = await readRegistry(repo)
    await writeRegistry(repo, { version: 1, sandboxes: [...stale.sandboxes, { ...base, id: "fresh" }] })
    await writeRegistry(repo, stale)
    const registry = await readRegistry(repo)
    expect(registry.sandboxes.map((entry) => entry.id)).toEqual(["seed"])
  })
})

describe("lab chaos registry race recovery", () => {
  it("keeps a concurrent writer from replacing an entry list with a stale snapshot", async () => {
    repo = await makeAttackRepo()
    await writeRegistry(repo, { version: 1, sandboxes: [] })
    const base: LabSandbox = {
      id: "seed",
      projectRoot: repo,
      repoRoot: repo,
      sandboxRoot: path.join(labPaths(repo).sandboxes, "seed"),
      adapter: "probe",
      baseCommit: "0".repeat(40),
      createdAt: new Date().toISOString(),
      status: "active",
      warnings: [],
    }
    await writeRegistry(repo, { version: 1, sandboxes: [base] })
    const stale = await readRegistry(repo)
    await writeRegistry(repo, { version: 1, sandboxes: [...stale.sandboxes, { ...base, id: "fresh" }] })
    await writeRegistry(repo, stale)
    const registry = await readRegistry(repo)
    expect(registry.sandboxes.map((entry) => entry.id)).toEqual(["seed"])
  })
})
