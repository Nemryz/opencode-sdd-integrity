import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LabSandbox } from "./types"
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

  try {
    await createWorktree(repoRoot, sandboxRoot)
    try {
      await overlayUncommitted(repoRoot, sandboxRoot)
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. Commit or stash the conflicting changes and create the sandbox again.`,
      )
    }
    const dependencyWarning = await linkNodeModules(repoRoot, sandboxRoot)
    if (dependencyWarning) warnings.push(dependencyWarning)
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
  }
  await upsertSandbox(options.projectRoot, sandbox)
  return sandbox
}

export async function loadSandbox(projectRoot: string, id?: string): Promise<LabSandbox> {
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
    throw new Error(
      `Lab sandbox ${sandbox.id} is missing at ${sandbox.sandboxRoot}; run destroy ${sandbox.id} to clean the registry`,
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
  if (sandbox.lastRunAt) lines.push(`  last run: ${sandbox.lastRunStatus ?? "unknown"} at ${sandbox.lastRunAt}`)
  if (sandbox.warnings.length > 0) {
    lines.push("  warnings:")
    lines.push(...sandbox.warnings.map((warning) => `    - ${warning}`))
  }
  return lines.join("\n")
}
