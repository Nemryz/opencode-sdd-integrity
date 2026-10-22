import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LabDependencyState, LabSandbox } from "./types"
import { hasNodeModules, readLockfile } from "./dependencies"
import { makeLabId } from "./fs"
import {
  createWorktree,
  findGitRoot,
  headCommit,
  linkNodeModules,
  overlayUncommitted,
  removeWorktree,
} from "./git"
import {
  getSandbox,
  latestSandbox,
  updateSandbox,
  upsertSandbox,
} from "./registry"

export interface CreateSandboxOptions {
  projectRoot: string
  adapter: string
  label?: string
}

export async function createSandbox(options: CreateSandboxOptions): Promise<LabSandbox> {
  const repoRoot = await findGitRoot(options.projectRoot)
  if (!repoRoot) {
    throw new Error("The test lab needs a git repository; initialize git or run the lab in a checkout")
  }
  const baseCommit = await headCommit(repoRoot)
  const id = makeLabId()
  const sandboxRoot = path.join(os.tmpdir(), "sdd-lab", id)
  const warnings: string[] = []
  let dependencies: LabDependencyState = {
    strategy: "missing",
    updatedAt: new Date().toISOString(),
  }

  try {
    await createWorktree(repoRoot, sandboxRoot)
    try {
      await overlayUncommitted(repoRoot, sandboxRoot)
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. Commit or stash the conflicting changes and create the sandbox again.`,
      )
    }

    const [sourceLockfile, sandboxLockfile, sourceHasNodeModules, sandboxHasNodeModules] = await Promise.all([
      readLockfile(repoRoot),
      readLockfile(sandboxRoot),
      hasNodeModules(repoRoot),
      hasNodeModules(sandboxRoot),
    ])
    const locksMatch = Boolean(
      sourceLockfile &&
        sandboxLockfile &&
        sourceLockfile.file === sandboxLockfile.file &&
        sourceLockfile.hash === sandboxLockfile.hash,
    )
    const now = new Date().toISOString()
    const lockDetails = sandboxLockfile
      ? { lockfile: sandboxLockfile.file, lockHash: sandboxLockfile.hash, manager: sandboxLockfile.manager }
      : {}

    if (sourceLockfile && sandboxLockfile && !locksMatch) {
      dependencies = { strategy: "pending", ...lockDetails, updatedAt: now }
      warnings.push(
        `The sandbox lockfile (${sandboxLockfile.file}) differs from the checkout lockfile (${sourceLockfile.file}); dependencies will be installed in the sandbox before the first run`,
      )
    } else if (sourceLockfile && !sandboxLockfile) {
      dependencies = { strategy: "missing", ...lockDetails, updatedAt: now }
      warnings.push(
        `The sandbox is missing ${sourceLockfile.file}; run destroy and create a new sandbox before running tests`,
      )
    } else if (sourceHasNodeModules && !sandboxHasNodeModules) {
      const dependencyWarning = await linkNodeModules(repoRoot, sandboxRoot)
      if (dependencyWarning) {
        warnings.push(dependencyWarning)
        dependencies = { strategy: "missing", ...lockDetails, updatedAt: now }
      } else {
        dependencies = { strategy: "linked", ...lockDetails, updatedAt: now }
      }
    } else if (sandboxHasNodeModules) {
      dependencies = { strategy: "linked", ...lockDetails, updatedAt: now }
    } else {
      dependencies = { strategy: "missing", ...lockDetails, updatedAt: now }
      if (sandboxLockfile) {
        warnings.push("node_modules is absent in the sandbox; dependencies will be installed before the first run")
      } else {
        warnings.push("node_modules is absent in the source checkout; run the project install before a full run")
      }
    }
  } catch (error) {
    await removeWorktree(repoRoot, sandboxRoot).catch(() => null)
    throw error
  }

  const sandbox: LabSandbox = {
    id,
    projectRoot: options.projectRoot,
    repoRoot,
    sandboxRoot,
    adapter: options.adapter,
    label: options.label,
    baseCommit,
    createdAt: new Date().toISOString(),
    status: "active",
    warnings,
    dependencies,
  }
  await upsertSandbox(options.projectRoot, sandbox)
  return sandbox
}

export interface LoadSandboxOptions {
  allowMissing?: boolean
}

export async function loadSandbox(
  projectRoot: string,
  id?: string,
  options: LoadSandboxOptions = {},
): Promise<LabSandbox> {
  const sandbox = id ? await getSandbox(projectRoot, id) : await latestSandbox(projectRoot)
  if (!sandbox) {
    throw new Error(
      id
        ? `Unknown lab sandbox: ${id}`
        : "No lab sandbox exists for this project; create one with subcommand create",
    )
  }
  if (sandbox.status === "destroyed") {
    throw new Error(`Lab sandbox ${sandbox.id} was destroyed; create a new one`)
  }
  try {
    await fs.lstat(sandbox.sandboxRoot)
  } catch {
    if (options.allowMissing) return sandbox
    throw new Error(
      `Lab sandbox ${sandbox.id} is missing at ${sandbox.sandboxRoot}; run destroy ${sandbox.id} with confirmed: true to clean the registry`,
    )
  }
  return sandbox
}

export async function markPromoted(projectRoot: string, id: string): Promise<LabSandbox | null> {
  return updateSandbox(projectRoot, id, {
    status: "promoted",
  })
}

export async function destroySandbox(projectRoot: string, sandbox: LabSandbox): Promise<LabSandbox | null> {
  await removeWorktree(sandbox.repoRoot, sandbox.sandboxRoot)
  const updated = await updateSandbox(projectRoot, sandbox.id, { status: "destroyed" })
  return updated
}

export function formatSandbox(sandbox: LabSandbox): string {
  const lines = [
    `Lab sandbox ${sandbox.id}`,
    `  path: ${sandbox.sandboxRoot}`,
    `  repository: ${sandbox.repoRoot}`,
    `  adapter: ${sandbox.adapter}`,
    `  base: ${sandbox.baseCommit.slice(0, 12)}`,
    `  created: ${sandbox.createdAt}`,
    `  status: ${sandbox.status}`,
  ]
  if (sandbox.label) lines.push(`  label: ${sandbox.label}`)
  if (sandbox.dependencies) {
    const manager = sandbox.dependencies.manager ? ` (${sandbox.dependencies.manager})` : ""
    const lockfile = sandbox.dependencies.lockfile ? ` via ${sandbox.dependencies.lockfile}` : ""
    lines.push(`  dependencies: ${sandbox.dependencies.strategy}${manager}${lockfile}`)
  }
  if (sandbox.lastRunAt) lines.push(`  last run: ${sandbox.lastRunStatus ?? "unknown"} at ${sandbox.lastRunAt}`)
  if (sandbox.warnings.length > 0) {
    lines.push("  warnings:")
    lines.push(...sandbox.warnings.map((warning) => `    - ${warning}`))
  }
  return lines.join("\n")
}
