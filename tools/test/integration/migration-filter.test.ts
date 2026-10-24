import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { removeDirWithRetry, repoRootDir } from "../helpers/setup"

const REPO_ROOT = repoRootDir()
const FIXTURE_DIR = path.join(REPO_ROOT, "tools", "test", "fixtures", "v1-migration")
const CLEAN = path.join(FIXTURE_DIR, "filter-clean.mjs")
const SMUDGE = path.join(FIXTURE_DIR, "filter-smudge.mjs")
const V1 = path.join(FIXTURE_DIR, "AGENTS.v1.md")
const V2 = path.join(FIXTURE_DIR, "AGENTS.v2.md")
const BLOCK = path.join(FIXTURE_DIR, "local-block.md")

const tempDirs: string[] = []

function runNode(script: string, input: string): string {
  return execFileSync(process.execPath, [script], {
    input,
    encoding: "utf-8",
    env: { ...process.env, LOCAL_BLOCK_FILE: BLOCK },
  })
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, LOCAL_BLOCK_FILE: BLOCK },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function gitStatus(cwd: string, args: string[]): number {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, LOCAL_BLOCK_FILE: BLOCK },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return result.status ?? 1
}

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-filter-"))
  tempDirs.push(repo)
  git(repo, ["init"])
  git(repo, ["config", "user.email", "test@example.com"])
  git(repo, ["config", "user.name", "Test"])
  git(repo, ["config", "core.autocrlf", "false"])
  const cleanCommand = `"${process.execPath}" "${CLEAN}"`
  const smudgeCommand = `"${process.execPath}" "${SMUDGE}"`
  git(repo, ["config", "filter.v1local.clean", cleanCommand])
  git(repo, ["config", "filter.v1local.smudge", smudgeCommand])
  git(repo, ["config", "filter.v1local.required", "true"])
  await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true })
  await fs.writeFile(path.join(repo, ".git", "info", "attributes"), "AGENTS.md filter=v1local\n")
  return repo
}

async function commitFile(repo: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(repo, "AGENTS.md"), content)
  git(repo, ["add", "AGENTS.md"])
  git(repo, ["commit", "-m", message])
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeDirWithRetry(dir)))
})

describe("V1 to V2 git filters", () => {
  it("keeps the clean and smudge fixtures in the shipped test surface", async () => {
    for (const file of [CLEAN, SMUDGE, V1, V2, BLOCK]) {
      await expect(fs.access(file)).resolves.toBeUndefined()
    }
  })

  it("strips exactly one local block and keeps the V2 body", async () => {
    const v2 = await fs.readFile(V2, "utf-8")
    const block = await fs.readFile(BLOCK, "utf-8")
    const cleaned = runNode(CLEAN, v2.trimEnd() + "\n\n" + block.trim() + "\n")
    expect(normalizeNewlines(cleaned)).toBe(normalizeNewlines(v2))
    expect(cleaned).not.toContain("LOCAL_ONLY")
  })

  it("smudges one block and stays idempotent", async () => {
    const v2 = await fs.readFile(V2, "utf-8")
    const smudged = runNode(SMUDGE, v2)
    expect(smudged.match(/<!-- local:start -->/g)).toHaveLength(1)
    expect(smudged.match(/LOCAL_ONLY/g)).toHaveLength(1)
    expect(runNode(SMUDGE, smudged)).toBe(smudged)
  })

  it("migrates from V1 to V2 with a single block in the worktree and none in git", async () => {
    const repo = await makeRepo()
    const v1 = await fs.readFile(V1, "utf-8")
    const v2 = await fs.readFile(V2, "utf-8")
    const block = await fs.readFile(BLOCK, "utf-8")
    await commitFile(repo, v1, "test: v1")
    git(repo, ["branch", "-m", "V1"])
    git(repo, ["switch", "-c", "V2"])
    await commitFile(repo, v2.trimEnd() + "\n\n" + block.trim() + "\n", "test: v2")

    git(repo, ["switch", "V1"])
    const v1Worktree = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    expect(v1Worktree).toContain("V1_ONLY")
    expect(v1Worktree.match(/LOCAL_ONLY/g)).toHaveLength(1)

    git(repo, ["switch", "V2"])
    const worktree = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    const head = git(repo, ["show", "HEAD:AGENTS.md"])
    const index = git(repo, ["show", ":AGENTS.md"])
    expect(worktree).toContain("V2_ONLY")
    expect(worktree).not.toContain("V1_ONLY")
    expect(worktree.match(/<!-- local:start -->/g)).toHaveLength(1)
    expect(worktree.match(/LOCAL_ONLY/g)).toHaveLength(1)
    expect(head).toContain("V2_ONLY")
    expect(head).not.toContain("LOCAL_ONLY")
    expect(index).toBe(head)
    expect(gitStatus(repo, ["diff", "--quiet"])).toBe(0)
    expect(gitStatus(repo, ["diff", "--cached", "--quiet"])).toBe(0)

    git(repo, ["switch", "V1"])
    git(repo, ["switch", "V2"])
    const second = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    expect(second.match(/<!-- local:start -->/g)).toHaveLength(1)
    expect(second.match(/LOCAL_ONLY/g)).toHaveLength(1)
    expect(second).toBe(worktree)
  })
})
