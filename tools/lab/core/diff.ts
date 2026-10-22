import path from "node:path"
import type { LabSandbox } from "./types"
import { makeLabId, writeTextAtomic } from "./fs"
import { applyPatch, collectPatch } from "./git"
import { ensureDiffDir } from "./registry"
import { markPromoted } from "./sandbox"

export interface SandboxDiff {
  patchPath: string
  stat: string
  files: string[]
  empty: boolean
}

export async function collectDiff(projectRoot: string, sandbox: LabSandbox): Promise<SandboxDiff> {
  const patch = await collectPatch(sandbox.sandboxRoot)
  const directory = await ensureDiffDir(projectRoot, sandbox.id)
  const patchPath = path.join(directory, `diff-${makeLabId()}.patch`)
  await writeTextAtomic(patchPath, patch.patch)
  return {
    patchPath,
    stat: patch.stat,
    files: patch.files,
    empty: patch.patch.trim() === "",
  }
}

export async function promoteDiff(
  projectRoot: string,
  sandbox: LabSandbox,
): Promise<SandboxDiff> {
  const diff = await collectDiff(projectRoot, sandbox)
  if (diff.empty) throw new Error("The sandbox has no changes to promote")
  await applyPatch(sandbox.repoRoot, diff.patchPath)
  await markPromoted(projectRoot, sandbox.id)
  return diff
}

export function formatDiff(diff: SandboxDiff): string {
  const lines = [
    diff.empty ? "No changes in the sandbox" : "Sandbox changes",
    `  files: ${diff.files.length}`,
    `  patch: ${diff.patchPath}`,
  ]
  if (diff.stat) {
    lines.push("", diff.stat)
  }
  if (!diff.empty) {
    lines.push("", "Review the patch before promoting. Promotion applies it to the checkout and never commits.")
  }
  return lines.join("\n")
}
