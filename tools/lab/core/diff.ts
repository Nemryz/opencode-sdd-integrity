import crypto from "node:crypto"
import path from "node:path"
import type { LabSandbox } from "./types"
import { makeLabId, writeTextAtomic } from "./fs"
import { applyPatch, collectPatch, headCommit } from "./git"
import { ensureDiffDir, getSandbox, updateSandbox } from "./registry"
import { markPromoted } from "./sandbox"

export interface SandboxDiff {
  patchPath: string
  stat: string
  files: string[]
  empty: boolean
  baseCommit: string
  currentHead: string
  patchHash: string
}

export async function collectDiff(projectRoot: string, sandbox: LabSandbox): Promise<SandboxDiff> {
  const patch = await collectPatch(sandbox.sandboxRoot)
  const currentHead = await headCommit(sandbox.repoRoot)
  const directory = await ensureDiffDir(projectRoot, sandbox.id)
  const patchPath = path.join(directory, `diff-${makeLabId()}.patch`)
  await writeTextAtomic(patchPath, patch.patch)
  const patchHash = crypto.createHash("sha256").update(patch.patch).digest("hex")
  return {
    patchPath,
    stat: patch.stat,
    files: patch.files,
    empty: patch.patch.trim() === "",
    baseCommit: sandbox.baseCommit,
    currentHead,
    patchHash,
  }
}

export async function reviewDiff(projectRoot: string, sandbox: LabSandbox): Promise<SandboxDiff> {
  const diff = await collectDiff(projectRoot, sandbox)
  const updated = await updateSandbox(projectRoot, sandbox.id, {
    lastDiffAt: new Date().toISOString(),
    lastDiffHash: diff.patchHash,
    lastDiffPath: diff.patchPath,
  })
  if (!updated) throw new Error(`Lab sandbox ${sandbox.id} disappeared while recording the reviewed patch`)
  return diff
}

export async function promoteDiff(
  projectRoot: string,
  sandbox: LabSandbox,
  options: { allowMoved?: boolean } = {},
): Promise<SandboxDiff> {
  const currentSandbox = (await getSandbox(projectRoot, sandbox.id)) ?? sandbox
  const diff = await collectDiff(projectRoot, sandbox)
  if (diff.empty) throw new Error("The sandbox has no changes to promote")
  if (diff.currentHead !== diff.baseCommit && !options.allowMoved) {
    throw new Error(
      `The checkout moved from ${diff.baseCommit.slice(0, 12)} to ${diff.currentHead.slice(0, 12)} since sandbox ${sandbox.id} was created; no files were promoted. The patch is at ${diff.patchPath}. Create a new sandbox against the current HEAD.`,
    )
  }
  if (currentSandbox.lastDiffHash !== diff.patchHash) {
    throw new Error(`Run diff after the latest sandbox change and review the patch before promoting. The reviewed patch hash is ${currentSandbox.lastDiffHash ?? "missing"} and the current patch hash is ${diff.patchHash}.`)
  }
  await applyPatch(sandbox.repoRoot, diff.patchPath, diff.baseCommit, { allowMoved: options.allowMoved })
  const appliedHead = await headCommit(sandbox.repoRoot)
  await markPromoted(projectRoot, sandbox.id, { patchHash: diff.patchHash, appliedHead })
  return diff
}

export function formatDiff(diff: SandboxDiff): string {
  const moved = diff.currentHead !== diff.baseCommit
  const lines = [
    diff.empty ? "No changes in the sandbox" : "Sandbox changes",
    `  files: ${diff.files.length}`,
    `  base: ${diff.baseCommit.slice(0, 12)}`,
    `  checkout: ${diff.currentHead.slice(0, 12)}${moved ? " (moved; create a new sandbox before promoting)" : ""}`,
    `  patch: ${diff.patchPath}`,
    `  hash: ${diff.patchHash}`,
  ]
  if (diff.stat) {
    lines.push("", diff.stat)
  }
  if (!diff.empty) {
    lines.push("", "Review the patch before promoting. Promotion applies it to the checkout and never commits.")
  }
  return lines.join("\n")
}
