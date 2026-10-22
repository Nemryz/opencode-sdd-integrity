import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { readRegistry, registryLock, upsertSandbox } from "../../lab/core/registry"
import type { LabSandbox } from "../../lab/core/types"

let project: string | null = null

afterEach(async () => {
  if (project) {
    await destroyTempWorktree(project)
    project = null
  }
})

function sandbox(projectRoot: string, id: string): LabSandbox {
  return {
    id,
    projectRoot,
    repoRoot: projectRoot,
    sandboxRoot: path.join(projectRoot, "sandbox", id),
    adapter: "node",
    baseCommit: "0".repeat(40),
    createdAt: new Date().toISOString(),
    status: "active",
    warnings: [],
  }
}

describe("lab registry lock", () => {
  it("serializes concurrent writes without losing entries", async () => {
    project = await createTempWorktree()
    const entries = Array.from({ length: 12 }, (_, index) => sandbox(project as string, `sandbox-${index}`))

    await Promise.all(entries.map((entry) => upsertSandbox(project as string, entry)))

    const registry = await readRegistry(project)
    expect(registry.sandboxes).toHaveLength(entries.length)
    expect(registry.sandboxes.map((entry) => entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort())
    await expect(fs.lstat(registryLock(project))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("removes a stale lock before writing", async () => {
    project = await createTempWorktree()
    const lock = registryLock(project)
    await fs.mkdir(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lock, old, old)

    await upsertSandbox(project, sandbox(project, "after-stale-lock"))

    const registry = await readRegistry(project)
    expect(registry.sandboxes.map((entry) => entry.id)).toContain("after-stale-lock")
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
