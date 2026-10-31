import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findGitRoot, listWorktrees, removeWorktree } from "./git"
import { labRoot, readRegistry, registryLock, sandboxReportDir, writeRegistry } from "./registry"
import { withLabLock } from "./fs"
import type { LabSandbox } from "./types"

export interface LabPruneOptions {
  projectRoot: string
  olderThanDays?: number
  confirmed?: boolean
  now?: Date
}

export interface LabPruneCandidate {
  id: string
  reason: "missing" | "destroyed" | "orphan-worktree"
  action: "mark-destroyed" | "remove" | "remove-worktree"
  path?: string
  ageDays?: number
}

export interface LabPruneResult {
  dryRun: boolean
  olderThanDays: number
  candidates: LabPruneCandidate[]
  removed: string[]
  markedDestroyed: string[]
  orphanWorktrees: string[]
}

function ageDays(sandbox: LabSandbox, now: Date): number {
  const value = sandbox.lastRunAt ?? sandbox.createdAt
  const time = Date.parse(value)
  if (Number.isNaN(time)) return 0
  return Math.floor((now.getTime() - time) / (24 * 60 * 60 * 1000))
}

function isLabWorktreePath(value: string): boolean {
  const labRoot = path.join(os.tmpdir(), "sdd-lab")
  const resolved = path.resolve(value)
  return resolved === labRoot || resolved.startsWith(labRoot + path.sep)
}

export async function pruneSandboxes(options: LabPruneOptions): Promise<LabPruneResult> {
  const olderThanDays = options.olderThanDays ?? 30
  const dryRun = options.confirmed !== true
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000
  const repoRoot = (await findGitRoot(options.projectRoot)) ?? options.projectRoot

  const candidates: LabPruneCandidate[] = []
  const toMarkDestroyed: LabSandbox[] = []
  const toRemove: LabSandbox[] = []
  const orphanWorktrees: string[] = []

  await withLabLock(registryLock(options.projectRoot), async () => {
    const registry = await readRegistry(options.projectRoot)
    const knownIds = new Set(registry.sandboxes.map((entry) => entry.id))

    for (const sandbox of registry.sandboxes) {
      let exists = true
      try {
        await fs.lstat(sandbox.sandboxRoot)
      } catch {
        exists = false
      }
      const age = ageDays(sandbox, now)
      if (!exists) {
        if (Date.parse(sandbox.lastRunAt ?? sandbox.createdAt) <= cutoff) {
          toRemove.push(sandbox)
          candidates.push({ id: sandbox.id, reason: "missing", action: "remove", path: sandbox.sandboxRoot, ageDays: age })
        } else {
          toMarkDestroyed.push(sandbox)
          candidates.push({ id: sandbox.id, reason: "missing", action: "mark-destroyed", path: sandbox.sandboxRoot, ageDays: age })
        }
      } else if (sandbox.status === "destroyed") {
        const time = Date.parse(sandbox.lastRunAt ?? sandbox.createdAt)
        if (!Number.isNaN(time) && time <= cutoff) {
          toRemove.push(sandbox)
          candidates.push({ id: sandbox.id, reason: "destroyed", action: "remove", path: sandbox.sandboxRoot, ageDays: age })
        }
      }
    }

    const worktrees = await listWorktrees(repoRoot)
    for (const worktree of worktrees) {
      if (!isLabWorktreePath(worktree)) continue
      const id = path.basename(worktree)
      if (knownIds.has(id)) continue
      orphanWorktrees.push(worktree)
      candidates.push({ id, reason: "orphan-worktree", action: "remove-worktree", path: worktree })
    }

    if (dryRun) return

    for (const sandbox of toMarkDestroyed) {
      const index = registry.sandboxes.findIndex((entry) => entry.id === sandbox.id)
      if (index !== -1) registry.sandboxes[index] = { ...registry.sandboxes[index], status: "destroyed" }
    }
    const removeIds = new Set(toRemove.map((entry) => entry.id))
    registry.sandboxes = registry.sandboxes.filter((entry) => !removeIds.has(entry.id))
    await writeRegistry(options.projectRoot, registry)
  })

  if (dryRun) {
    return {
      dryRun: true,
      olderThanDays,
      candidates,
      removed: [],
      markedDestroyed: [],
      orphanWorktrees: [],
    }
  }

  const markedDestroyed = toMarkDestroyed.map((entry) => entry.id)
  const removed = toRemove.map((entry) => entry.id)

  for (const sandbox of toMarkDestroyed) {
    await removeWorktree(repoRoot, sandbox.sandboxRoot).catch(() => null)
  }
  for (const sandbox of toRemove) {
    await fs.rm(sandboxReportDir(options.projectRoot, sandbox.id), { recursive: true, force: true }).catch(() => null)
  }
  for (const worktree of orphanWorktrees) {
    await removeWorktree(repoRoot, worktree).catch(() => null)
  }

  return {
    dryRun: false,
    olderThanDays,
    candidates,
    removed,
    markedDestroyed,
    orphanWorktrees,
  }
}
