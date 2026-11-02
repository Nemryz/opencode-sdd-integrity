import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createSandbox, destroySandbox } from "../../lab/core/sandbox"
import { readRegistry, upsertSandbox } from "../../lab/core/registry"
import { pruneSandboxes } from "../../lab/core/prune"
import { labPaths } from "../../lab/core/home"
import { makeAttackRepo, destroyAttackRepo } from "../helpers/corpus"
import type { LabSandbox } from "../../lab/core/types"
import { defaultSandboxPolicy } from "../../lab/core/types"

let repo: string | null = null
let created: LabSandbox[] = []

afterEach(async () => {
  for (const sandbox of created) {
    if (sandbox.status === "active") {
      await destroySandbox(sandbox.projectRoot, { ...sandbox, status: "active" }, true).catch(() => null)
    }
  }
  created = []
  if (repo) {
    await destroyAttackRepo(repo)
    repo = null
  }
})

describe("lab concurrency registry writes", () => {
  it("keeps every entry when many writers upsert at the same moment", async () => {
    repo = await makeAttackRepo()
    const writers: LabSandbox[] = []
    for (let index = 0; index < 8; index += 1) {
      const id = `sand-${index}`
      writers.push({
        id,
        projectRoot: repo,
        repoRoot: repo,
        sandboxRoot: path.join(labPaths(repo).sandboxes, id),
        adapter: "probe",
        provider: "worktree",
        trust: "trusted",
        policy: defaultSandboxPolicy(),
        baseCommit: "0".repeat(40),
        createdAt: new Date().toISOString(),
        status: "active",
        warnings: [],
      })
    }
    await Promise.all(writers.map((writer) => upsertSandbox(repo as string, writer)))
    const ids = await readRegistry(repo).then((registry) => registry.sandboxes.map((entry) => entry.id).sort())
    expect(ids).toEqual(writers.map((writer) => writer.id).sort())
  })
})

describe("lab concurrency sandboxes", () => {
  it("creates three sandboxes at once without losing one of them", async () => {
    repo = await makeAttackRepo()
    const heads = await Promise.all([
      createSandbox({ projectRoot: repo, adapter: "probe" }),
      createSandbox({ projectRoot: repo, adapter: "probe" }),
      createSandbox({ projectRoot: repo, adapter: "probe" }),
    ])
    for (const sandbox of heads) created.push({ ...sandbox, status: "active" })
    const ids = new Set(heads.map((sandbox) => sandbox.id))
    expect(ids.size).toBe(3)
    const registryIds = await readRegistry(repo).then((registry) => registry.sandboxes.map((entry) => entry.id))
    expect(registryIds.sort()).toEqual([...ids].sort())
    for (const sandbox of heads) {
      expect(await fs.access(sandbox.sandboxRoot).then(() => true, () => false)).toBe(true)
    }
  })

  it("destroys two different sandboxes in parallel and records both statuses", async () => {
    repo = await makeAttackRepo()
    const first = await createSandbox({ projectRoot: repo, adapter: "probe" })
    const second = await createSandbox({ projectRoot: repo, adapter: "probe" })
    created.push(
      { ...first, status: "active" },
      { ...second, status: "active" },
    )
    const settled = await Promise.all([
      destroySandbox(repo, first, true),
      destroySandbox(repo, second, true),
    ])
    expect(settled.map((entry) => entry?.status)).toEqual(["destroyed", "destroyed"])
    for (const sandbox of created) sandbox.status = "destroyed"
    const statuses = await readRegistry(repo).then((registry) =>
      registry.sandboxes.map((entry) => `${entry.id}:${entry.status}`),
    )
    expect(statuses.sort()).toEqual([`${first.id}:destroyed`, `${second.id}:destroyed`].sort())
  })

  it("never flags a sandbox that is being created as a prune candidate", async () => {
    repo = await makeAttackRepo()
    const [sandbox, during] = await Promise.all([
      createSandbox({ projectRoot: repo, adapter: "probe" }),
      pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: false }),
    ])
    created.push({ ...sandbox, status: "active" })
    expect(during.candidates.find((candidate) => candidate.id === sandbox.id)).toBeUndefined()
    await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: false }).then((after) => {
      expect(after.candidates.find((candidate) => candidate.id === sandbox.id)).toBeUndefined()
    })
  })
})
