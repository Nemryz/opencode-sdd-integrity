import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, mockContext, repoRootDir } from "../helpers/setup"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import { pruneSandboxes } from "../../lab/core/prune"
import { readRegistry, upsertSandbox } from "../../lab/core/registry"
import { removeWorktree } from "../../lab/core/git"
import speckitLab from "../../speckit-lab"
import type { LabSandbox } from "../../lab/core/types"

let repo: string

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

beforeEach(async () => {
  repo = await createTempWorktree()
  git(["init", "-q"])
  git(["config", "user.email", "lab@example.com"])
  git(["config", "user.name", "Lab Tester"])
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "lab-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2), "utf-8")
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf-8")
  git(["add", "-A"])
  git(["commit", "-m", "base"])
})

afterEach(async () => {
  const registry = await readRegistry(repo).catch(() => null)
  for (const sandbox of registry?.sandboxes ?? []) {
    if (sandbox.status !== "destroyed") await removeWorktree(sandbox.repoRoot, sandbox.sandboxRoot).catch(() => null)
  }
  await destroyTempWorktree(repo)
})

function sandbox(id: string, status: LabSandbox["status"], root: string): LabSandbox {
  return {
    id,
    projectRoot: repo,
    repoRoot: repo,
    sandboxRoot: root,
    adapter: "node",
    baseCommit: "0".repeat(40),
    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    status,
    warnings: [],
  }
}

describe("lab prune", () => {
  it("dry-runs stale destroyed sandboxes without deleting them", async () => {
    const root = path.join(repo, "sandbox", "old")
    await fs.mkdir(root, { recursive: true })
    await upsertSandbox(repo, sandbox("old-sandbox", "destroyed", root))

    const result = await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: false })
    expect(result.dryRun).toBe(true)
    expect(result.candidates.map((entry) => entry.id)).toContain("old-sandbox")
    expect(await readRegistry(repo).then((registry) => registry.sandboxes.map((entry) => entry.id))).toContain("old-sandbox")
  })

  it("removes stale destroyed sandboxes and their reports when confirmed", async () => {
    const root = path.join(repo, "sandbox", "old")
    const reportDir = path.join(repo, "reports", "lab", "old-sandbox")
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(reportDir, { recursive: true })
    await fs.writeFile(path.join(reportDir, "summary.json"), "{}", "utf-8")
    await upsertSandbox(repo, sandbox("old-sandbox", "destroyed", root))

    const result = await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: true })
    expect(result.removed).toContain("old-sandbox")
    await expect(fs.lstat(reportDir)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readRegistry(repo).then((registry) => registry.sandboxes.map((entry) => entry.id))).not.toContain("old-sandbox")
  })

  it("marks a missing active sandbox as destroyed without deleting recent reports", async () => {
    const root = path.join(repo, "sandbox", "missing")
    const reportDir = path.join(repo, "reports", "lab", "missing-sandbox")
    await fs.mkdir(reportDir, { recursive: true })
    const recent = sandbox("missing-sandbox", "active", root)
    recent.createdAt = new Date().toISOString()
    await upsertSandbox(repo, recent)

    const result = await pruneSandboxes({ projectRoot: repo, olderThanDays: 30, confirmed: true })
    expect(result.markedDestroyed).toContain("missing-sandbox")
    await expect(fs.lstat(reportDir)).resolves.toBeDefined()
    expect((await readRegistry(repo)).sandboxes.find((entry) => entry.id === "missing-sandbox")?.status).toBe("destroyed")
  })
})

describe("speckit-lab prune command", () => {
  it("dry-runs through the tool and applies only after confirmation", async () => {
    const root = path.join(repo, "sandbox", "old")
    await fs.mkdir(root, { recursive: true })
    await upsertSandbox(repo, sandbox("old-sandbox", "destroyed", root))

    const dry = await speckitLab.execute({ subcommand: "prune", olderThanDays: 30 }, mockContext(repo))
    expect(dry.title).toBe("Lab Prune: Dry Run")

    const applied = await speckitLab.execute({ subcommand: "prune", olderThanDays: 30, confirmed: true }, mockContext(repo))
    expect(applied.title).toBe("Lab Prune: Completed")
  })
})
