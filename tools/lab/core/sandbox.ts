import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LabDependencyState, LabSandbox, SandboxProviderId, SandboxTrust } from "./types"
import { defaultSandboxPolicy } from "./types"
import { hasNodeModules, readLockfile } from "./dependencies"
import { makeLabId } from "./fs"
import { ensureLabHome, labPaths } from "./home"
import { disableSandboxHooks, prepareSandboxPermissions } from "./permissions"
import {
  createWorktree,
  findGitRoot,
  headCommit,
  linkNodeModules,
  overlayUncommitted,
  removeWorktree,
} from "./git"
import { appendLabAudit } from "./audit"
import {
  getSandbox,
  latestSandbox,
  updateSandbox,
  upsertSandbox,
} from "./registry"
import { isLabSandboxRoot } from "./home"
import { DEFAULT_PROVIDER_ID, PROVIDER_LIBRARY } from "./provider"

export interface CreateSandboxOptions {
  projectRoot: string
  adapter: string
  label?: string
  trust?: SandboxTrust
  provider?: SandboxProviderId
}

export async function createSandbox(options: CreateSandboxOptions): Promise<LabSandbox> {
  const trust = options.trust ?? "trusted"
  const providerId = options.provider ?? DEFAULT_PROVIDER_ID
  const provider = PROVIDER_LIBRARY[providerId]
  const availability = provider.availability()
  if (!availability.available) {
    throw new Error(`The ${providerId} provider is unavailable for this sandbox: ${availability.reason}`)
  }
  const repoRoot = await findGitRoot(options.projectRoot)
  if (!repoRoot) {
    throw new Error("The test lab needs a git repository; initialize git or run the lab in a checkout")
  }
  const baseCommit = await headCommit(repoRoot)
  const id = makeLabId()
  const sandboxRoot = path.join(labPaths(options.projectRoot).sandboxes, id)
  await ensureLabHome(options.projectRoot)
  const warnings: string[] = []
  let dependencies: LabDependencyState = {
    strategy: "missing",
    updatedAt: new Date().toISOString(),
  }

  try {
    await createWorktree(repoRoot, sandboxRoot)
    await prepareSandboxPermissions(sandboxRoot)
    await disableSandboxHooks(sandboxRoot)
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
    const sourceDetails = sourceLockfile
      ? { sourceLockfile: sourceLockfile.file, sourceLockHash: sourceLockfile.hash }
      : {}

    if (sourceLockfile && sandboxLockfile && !locksMatch) {
      dependencies = { strategy: "pending", ...lockDetails, ...sourceDetails, updatedAt: now }
      warnings.push(
        `The sandbox lockfile (${sandboxLockfile.file}) differs from the checkout lockfile (${sourceLockfile.file}); dependencies will be installed in the sandbox before the first run`,
      )
    } else if (sourceLockfile && !sandboxLockfile) {
      dependencies = { strategy: "missing", ...lockDetails, ...sourceDetails, updatedAt: now }
      warnings.push(
        `The sandbox is missing ${sourceLockfile.file}; run destroy and create a new sandbox before running tests`,
      )
    } else if (sourceHasNodeModules && !sandboxHasNodeModules) {
      const dependencyWarning = await linkNodeModules(repoRoot, sandboxRoot)
      if (dependencyWarning) {
        warnings.push(dependencyWarning)
        dependencies = { strategy: "missing", ...lockDetails, ...sourceDetails, updatedAt: now }
      } else {
        dependencies = { strategy: "linked", ...lockDetails, ...sourceDetails, updatedAt: now }
      }
    } else if (sandboxHasNodeModules) {
      dependencies = { strategy: "linked", ...lockDetails, ...sourceDetails, updatedAt: now }
    } else {
      dependencies = { strategy: "missing", ...lockDetails, ...sourceDetails, updatedAt: now }
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
    provider: providerId,
    trust,
    policy: defaultSandboxPolicy(),
    label: options.label,
    baseCommit,
    createdAt: new Date().toISOString(),
    status: "active",
    warnings,
    dependencies,
  }
  await upsertSandbox(options.projectRoot, sandbox)
  await appendLabAudit({
    kind: "lab_created",
    projectRoot: options.projectRoot,
    when: new Date().toISOString(),
    sandboxId: sandbox.id,
    isolationProvider: providerId,
    details: {
      adapter: sandbox.adapter,
      trust: sandbox.trust,
      repoRoot: sandbox.repoRoot,
      created: sandbox.createdAt,
    },
  })
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

export async function markPromoted(
  projectRoot: string,
  id: string,
  details: { patchHash?: string; appliedHead?: string } = {},
): Promise<LabSandbox | null> {
  const updated = await updateSandbox(projectRoot, id, {
    status: "promoted",
    promotedAt: new Date().toISOString(),
    promotedHead: details.appliedHead,
    promotedPatchHash: details.patchHash,
  })
  if (updated) {
    await appendLabAudit({
      kind: "lab_promoted",
      projectRoot,
      when: new Date().toISOString(),
      sandboxId: id,
      isolationProvider: updated.provider,
      details: { patchHash: details.patchHash, appliedHead: details.appliedHead },
    })
  }
  return updated
}

// Destroys a sandbox only after a second containment check, so a tampered registry entry cannot delete host paths.
export async function destroySandbox(projectRoot: string, sandbox: LabSandbox, confirmed: boolean): Promise<LabSandbox | null> {
  if (confirmed !== true) throw new Error("Confirm lab destroy with confirmed true before the sandbox is removed")
  if (!isLabSandboxRoot(projectRoot, sandbox.sandboxRoot)) {
    throw new Error(`Lab sandbox ${sandbox.id} claims a root outside ${labPaths(projectRoot).sandboxes}; refusing to destroy`)
  }
  await removeWorktree(sandbox.repoRoot, sandbox.sandboxRoot)
  const updated = await updateSandbox(projectRoot, sandbox.id, { status: "destroyed" })
  await appendLabAudit({
    kind: "lab_destroyed",
    projectRoot,
    when: new Date().toISOString(),
    sandboxId: sandbox.id,
    isolationProvider: sandbox.provider,
    details: { destroyed: sandbox.sandboxRoot },
  })
  return updated
}

export function formatSandbox(sandbox: LabSandbox): string {
  const lines = [
    `Lab sandbox ${sandbox.id}`,
    `  path: ${sandbox.sandboxRoot}`,
    `  repository: ${sandbox.repoRoot}`,
    `  adapter: ${sandbox.adapter}`,
    `  provider: ${sandbox.provider} (${sandbox.trust})`,
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
