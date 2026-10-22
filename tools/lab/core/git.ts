import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runLabProcess, type LabProcessResult } from "./runner"

const GIT_TIMEOUT_MS = 2 * 60 * 1000
const PATCH_LIMIT = 32 * 1024 * 1024

async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<LabProcessResult> {
  return runLabProcess("git", args, {
    cwd,
    timeoutMs,
    maxOutputBytes: PATCH_LIMIT,
  })
}

async function gitOrThrow(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const result = await git(cwd, args, timeoutMs)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

export async function findGitRoot(start: string): Promise<string | null> {
  const result = await git(start, ["rev-parse", "--show-toplevel"])
  if (result.code !== 0) return null
  const root = result.stdout.trim()
  return root === "" ? null : path.resolve(root)
}

export async function headCommit(repoRoot: string): Promise<string> {
  return (await gitOrThrow(repoRoot, ["rev-parse", "HEAD"])).trim()
}

export async function createWorktree(repoRoot: string, sandboxRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(sandboxRoot), { recursive: true })
  await gitOrThrow(repoRoot, ["worktree", "add", "--detach", sandboxRoot, "HEAD"])
}

export async function removeWorktree(repoRoot: string, sandboxRoot: string): Promise<void> {
  const removed = await git(repoRoot, ["worktree", "remove", "--force", sandboxRoot])
  if (removed.code !== 0) {
    await fs.rm(sandboxRoot, { recursive: true, force: true })
  }
  await git(repoRoot, ["worktree", "prune"]).catch(() => null)
}

export interface OverlayResult {
  patched: boolean
  untracked: number
}

// Replays the checkout's uncommitted work in the sandbox so a run sees the files the author sees.
export async function overlayUncommitted(repoRoot: string, sandboxRoot: string): Promise<OverlayResult> {
  const diff = await git(repoRoot, ["diff", "--binary", "HEAD"])
  if (diff.code !== 0) {
    throw new Error(`Could not read the working tree diff: ${(diff.stderr || diff.stdout).trim()}`)
  }
  if (diff.truncated) throw new Error("The working tree diff is too large for the lab overlay")

  let patched = false
  if (diff.stdout.trim() !== "") {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-lab-patch-"))
    const patchFile = path.join(temporary, "overlay.patch")
    try {
      await fs.writeFile(patchFile, diff.stdout, "utf-8")
      const applied = await git(sandboxRoot, ["apply", "--whitespace=nowarn", patchFile])
      if (applied.code !== 0) {
        throw new Error(`Could not replay uncommitted changes in the sandbox: ${(applied.stderr || applied.stdout).trim()}`)
      }
      patched = true
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }

  const untrackedResult = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (untrackedResult.code !== 0) {
    throw new Error(`Could not list untracked files: ${(untrackedResult.stderr || untrackedResult.stdout).trim()}`)
  }
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean)
  for (const relative of untracked) {
    const source = path.join(repoRoot, relative)
    const destination = path.join(sandboxRoot, relative)
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink()) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const target = await fs.readlink(source)
      await fs.symlink(target, destination)
      continue
    }
    if (!stat.isFile()) continue
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    await fs.chmod(destination, stat.mode & 0o777)
  }

  return { patched, untracked: untracked.length }
}

// Links the dependency tree instead of copying it. The link is absolute so it survives a different sandbox path.
export async function linkNodeModules(repoRoot: string, sandboxRoot: string): Promise<string | null> {
  const source = path.join(repoRoot, "node_modules")
  const destination = path.join(sandboxRoot, "node_modules")
  try {
    await fs.lstat(source)
  } catch {
    return "node_modules is absent in the source checkout; run the project install before a full run"
  }
  try {
    await fs.lstat(destination)
    return null
  } catch {
    // the worktree does not carry ignored dependencies, so the link is expected to be missing
  }
  try {
    await fs.symlink(source, destination, process.platform === "win32" ? "junction" : "dir")
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `node_modules could not be linked (${detail}); run the project install inside the sandbox`
  }
}

export interface SandboxPatch {
  patch: string
  stat: string
  files: string[]
}

// Stages only intentional project files, excluding dependency and report directories the lab owns.
export async function collectPatch(sandboxRoot: string): Promise<SandboxPatch> {
  const add = await git(sandboxRoot, [
    "add",
    "-A",
    "--",
    ".",
    ":(exclude)node_modules",
    ":(exclude).lab-cache",
    ":(exclude)coverage",
    ":(exclude)reports",
  ])
  if (add.code !== 0) {
    throw new Error(`Could not stage sandbox changes: ${(add.stderr || add.stdout).trim()}`)
  }
  const patch = await git(sandboxRoot, ["diff", "--cached", "--binary", "HEAD"])
  if (patch.code !== 0) {
    throw new Error(`Could not build the sandbox patch: ${(patch.stderr || patch.stdout).trim()}`)
  }
  if (patch.truncated) throw new Error("The sandbox patch is too large to promote safely")
  const stat = await gitOrThrow(sandboxRoot, ["diff", "--cached", "--stat", "HEAD"])
  const names = await gitOrThrow(sandboxRoot, ["diff", "--cached", "--name-only", "HEAD"])
  return {
    patch: patch.stdout,
    stat: stat.trim(),
    files: names.split(/\r?\n/).filter(Boolean),
  }
}

export async function statusShort(sandboxRoot: string): Promise<string> {
  const result = await git(sandboxRoot, ["status", "--short"])
  return result.code === 0 ? result.stdout.trim() : ""
}

export async function applyPatch(repoRoot: string, patchFile: string): Promise<void> {
  const check = await git(repoRoot, ["apply", "--check", "--3way", patchFile])
  if (check.code !== 0) {
    throw new Error(`The patch does not apply cleanly: ${(check.stderr || check.stdout).trim()}`)
  }
  const applied = await git(repoRoot, ["apply", "--3way", patchFile])
  if (applied.code !== 0) {
    throw new Error(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`)
  }
}
