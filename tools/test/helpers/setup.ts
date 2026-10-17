import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "@opencode-ai/plugin"

let repoRootCache: string | null = null

// Asks git for the checkout root, because walking up by a fixed depth lands on a sandbox folder when the tool runs outside the checkout.
// The walk stays as the fallback for an installed kit that carries no git metadata, and the answer is cached because the root cannot change while the suite runs.
export function repoRootDir(): string {
  if (repoRootCache) return repoRootCache
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: moduleDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    })
    const root = output.trim()
    if (root) {
      repoRootCache = root
      return repoRootCache
    }
  } catch {
    // not a git checkout, so the walk below decides
  }
  repoRootCache = path.resolve(moduleDir, "..", "..", "..")
  return repoRootCache
}

let ownedFilesCache: Set<string> | null = null

// Joins a path relative to the checkout root, so a test that reads shipped content keeps working when the code runs from a sandbox.
export function repoPath(...segments: string[]): string {
  return path.join(repoRootDir(), ...segments)
}

export function ownedRepoFiles(): Set<string> {
  if (ownedFilesCache) return ownedFilesCache
  const owned = new Set<string>()
  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: repoRootDir(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    })
    for (const line of output.split("\n")) {
      const trimmed = line.trim()
      if (trimmed) owned.add(trimmed.replace(/\\/g, "/"))
    }
  } catch {
    // not a git checkout (e.g. installed kit) → treated as "everything is ours"
  }
  ownedFilesCache = owned
  return owned
}

export function isKitOwned(relPath: string): boolean {
  const owned = ownedRepoFiles()
  if (owned.size === 0) return true
  return owned.has(relPath.replace(/\\/g, "/"))
}

export function mockContext(worktree: string): ToolContext {
  return {
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

export async function createTempWorktree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-test-"))
  await fs.mkdir(path.join(dir, ".opencode", "spec-memory"), { recursive: true })
  return dir
}

export async function createConstitution(worktree: string): Promise<void> {
  const specMemory = path.join(worktree, ".opencode", "spec-memory")
  await fs.mkdir(specMemory, { recursive: true })
  await fs.writeFile(path.join(specMemory, "constitution.md"), "# Test Constitution\n", "utf-8")
}

const REMOVE_RETRIES = 5
const REMOVE_RETRY_DELAY_MS = 50

export async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRIES; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const transient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM"
      if (!transient || attempt === REMOVE_RETRIES - 1) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS * (attempt + 1)))
    }
  }
}

export async function destroyTempWorktree(dir: string): Promise<void> {
  await removeDirWithRetry(dir)
}
