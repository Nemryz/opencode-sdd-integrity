import { describe, it, expect, beforeAll, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { removeDirWithRetry, repoRootDir } from "../helpers/setup"

const REPO_ROOT = repoRootDir()
const FIXTURE_DIR = path.join(REPO_ROOT, "tools", "test", "fixtures", "v1-migration")
const ENGRAM_ROOT = path.join(REPO_ROOT, "node_modules", "opencode-engram-learning")
const CLEAN = path.join(ENGRAM_ROOT, "scripts", "opencode-engram-clean")
const SMUDGE = path.join(ENGRAM_ROOT, "scripts", "opencode-engram-smudge")
const BLOCK = path.join(FIXTURE_DIR, "engram-block.md")
const V1 = path.join(FIXTURE_DIR, "AGENTS.v1.md")
const V2 = path.join(FIXTURE_DIR, "AGENTS.v2.md")

const tempDirs: string[] = []
let python = ""

function findPython(): string {
  const candidates = [process.env.PYTHON, "python3", "python"].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf-8", timeout: 5000 })
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (result.status === 0 && /Python 3/.test(output)) return candidate
  }
  throw new Error("Python 3 is required to run the real Engram filter")
}

beforeAll(() => {
  python = findPython()
})

function runPython(script: string, input: string, cwd: string): string {
  return execFileSync(python, [script], { cwd, input, encoding: "utf-8" })
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function gitStatus(cwd: string, args: string[]): number {
  const result = spawnSync("git", args, {
    cwd,
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
  const scripts = path.join(repo, ".opencode", "scripts")
  await fs.mkdir(scripts, { recursive: true })
  await fs.copyFile(CLEAN, path.join(scripts, "opencode-engram-clean"))
  await fs.copyFile(SMUDGE, path.join(scripts, "opencode-engram-smudge"))
  await fs.copyFile(BLOCK, path.join(repo, ".opencode", ".engram-smudge-template"))
  git(repo, ["config", "filter.engram.clean", `"${python}" .opencode/scripts/opencode-engram-clean`])
  git(repo, ["config", "filter.engram.smudge", `"${python}" .opencode/scripts/opencode-engram-smudge`])
  git(repo, ["config", "filter.engram.required", "true"])
  await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true })
  await fs.writeFile(path.join(repo, ".git", "info", "attributes"), "AGENTS.md filter=engram\n")
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

describe("V1 to V2 Engram filters", () => {
  it("uses the real Engram 1.15.1 filter scripts", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ENGRAM_ROOT, "package.json"), "utf-8")) as { version: string }
    expect(pkg.version).toBe("1.15.1")
    for (const file of [CLEAN, SMUDGE, BLOCK, V1, V2]) {
      await expect(fs.access(file)).resolves.toBeUndefined()
    }
  })

  it("strips every Engram block and keeps the V2 body", async () => {
    const repo = await makeRepo()
    const v2 = await fs.readFile(V2, "utf-8")
    const block = await fs.readFile(BLOCK, "utf-8")
    const cleaned = runPython(path.join(repo, ".opencode", "scripts", "opencode-engram-clean"), block + block + v2, repo)
    expect(cleaned).toBe(v2)
    expect(cleaned).not.toContain("ENGRAM_ONLY")
  })

  it("smudges one block and stays idempotent", async () => {
    const repo = await makeRepo()
    const v2 = await fs.readFile(V2, "utf-8")
    const block = await fs.readFile(BLOCK, "utf-8")
    const smudged = runPython(path.join(repo, ".opencode", "scripts", "opencode-engram-smudge"), v2, repo)
    expect(smudged).toBe(block + v2)
    expect(runPython(path.join(repo, ".opencode", "scripts", "opencode-engram-smudge"), smudged, repo)).toBe(smudged)
  })

  it("leaves content alone when the template is missing", async () => {
    const repo = await makeRepo()
    const v2 = await fs.readFile(V2, "utf-8")
    await fs.rm(path.join(repo, ".opencode", ".engram-smudge-template"))
    expect(runPython(path.join(repo, ".opencode", "scripts", "opencode-engram-smudge"), v2, repo)).toBe(v2)
  })

  it("preserves CRLF line endings while stripping a block", async () => {
    const repo = await makeRepo()
    const v2 = (await fs.readFile(V2, "utf-8")).replace(/\n/g, "\r\n")
    const block = (await fs.readFile(BLOCK, "utf-8")).replace(/\n/g, "\r\n")
    const cleaned = runPython(path.join(repo, ".opencode", "scripts", "opencode-engram-clean"), block + v2, repo)
    expect(cleaned).toBe(v2)
  })

  it("migrates between orphan V1 and V2 branches with a single block in the worktree", async () => {
    const repo = await makeRepo()
    const v1 = await fs.readFile(V1, "utf-8")
    const v2 = await fs.readFile(V2, "utf-8")
    const block = await fs.readFile(BLOCK, "utf-8")
    await commitFile(repo, v1, "test: v1")
    git(repo, ["branch", "-m", "V1"])
    git(repo, ["switch", "--orphan", "V2"])
    await commitFile(repo, block + v2, "test: v2")
    expect(gitStatus(repo, ["merge-base", "V1", "V2"])).not.toBe(0)

    git(repo, ["switch", "V1"])
    const v1Worktree = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    expect(v1Worktree).toContain("V1_ONLY")
    expect(v1Worktree.match(/<!-- engram v1\.15\.1 -->/g)).toHaveLength(1)
    expect(v1Worktree.match(/ENGRAM_ONLY/g)).toHaveLength(1)

    git(repo, ["switch", "V2"])
    const worktree = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    const head = git(repo, ["show", "HEAD:AGENTS.md"])
    const index = git(repo, ["show", ":AGENTS.md"])
    expect(worktree).toContain("V2_ONLY")
    expect(worktree).not.toContain("V1_ONLY")
    expect(worktree.match(/<!-- engram v1\.15\.1 -->/g)).toHaveLength(1)
    expect(worktree.match(/ENGRAM_ONLY/g)).toHaveLength(1)
    expect(head).toContain("V2_ONLY")
    expect(head).not.toContain("ENGRAM_ONLY")
    expect(index).toBe(head)
    expect(gitStatus(repo, ["diff", "--quiet"])).toBe(0)
    expect(gitStatus(repo, ["diff", "--cached", "--quiet"])).toBe(0)

    git(repo, ["switch", "V1"])
    git(repo, ["switch", "V2"])
    const second = await fs.readFile(path.join(repo, "AGENTS.md"), "utf-8")
    expect(second).toBe(worktree)
  })
})
