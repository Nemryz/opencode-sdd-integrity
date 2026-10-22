import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, mockContext, repoPath, repoRootDir } from "../helpers/setup"
import { collectDiff, promoteDiff } from "../../lab/core/diff"
import { readRegistry } from "../../lab/core/registry"
import { removeWorktree } from "../../lab/core/git"
import { runLabProcess } from "../../lab/core/runner"
import { runLab } from "../../lab/core/run"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import type { LabAdapter } from "../../lab/core/types"
import { selectAdapter } from "../../lab/adapters"
import speckitLab from "../../speckit-lab"

let repo: string

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

async function writeRepoFile(relative: string, content: string): Promise<void> {
  const file = path.join(repo, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf-8")
}

// Git may check text files out with CRLF on Windows, so content assertions normalize before comparing.
async function readText(file: string): Promise<string> {
  return (await fs.readFile(file, "utf-8")).replace(/\r\n/g, "\n")
}

beforeEach(async () => {
  repo = await createTempWorktree()
  git(["init", "-q"])
  git(["config", "user.email", "lab@example.com"])
  git(["config", "user.name", "Lab Tester"])
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "lab-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2),
    "utf-8",
  )
  await writeRepoFile("README.md", "base\n")
  await writeRepoFile("tools/test/unit/sample.test.ts", "// sample\n")
  git(["add", "-A"])
  git(["commit", "-m", "base"])
})

afterEach(async () => {
  const registry = await readRegistry(repo).catch(() => null)
  for (const sandbox of registry?.sandboxes ?? []) {
    if (sandbox.status !== "destroyed") {
      await removeWorktree(sandbox.repoRoot, sandbox.sandboxRoot).catch(() => null)
    }
  }
  await destroyTempWorktree(repo)
})

describe("lab worktree lifecycle", () => {
  it("creates a detached worktree and replays uncommitted and untracked work", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "dirty\n", "utf-8")
    await writeRepoFile("tools/test/unit/untracked.test.ts", "// untracked\n")

    const sandbox = await createSandbox({ projectRoot: repo, adapter: "integrity" })
    expect(sandbox.baseCommit).toHaveLength(40)
    expect(await readText(path.join(sandbox.sandboxRoot, "README.md"))).toBe("dirty\n")
    expect(await readText(path.join(sandbox.sandboxRoot, "tools/test/unit/untracked.test.ts"))).toBe(
      "// untracked\n",
    )

    await destroySandbox(repo, sandbox)
    await expect(fs.lstat(sandbox.sandboxRoot)).rejects.toMatchObject({ code: "ENOENT" })
    const registry = await readRegistry(repo)
    expect(registry.sandboxes.find((entry) => entry.id === sandbox.id)?.status).toBe("destroyed")
  })

  it("builds a patch, promotes it into the checkout, and keeps reports separate", async () => {
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "node" })
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "sandbox\n", "utf-8")
    const improved = path.join(sandbox.sandboxRoot, "tools/test/unit/improved.test.ts")
    await fs.mkdir(path.dirname(improved), { recursive: true })
    await fs.writeFile(improved, "// improved\n", "utf-8")

    const diff = await collectDiff(repo, sandbox)
    expect(diff.empty).toBe(false)
    expect(diff.files).toContain("README.md")
    expect(diff.files).toContain("tools/test/unit/improved.test.ts")
    await expect(fs.readFile(diff.patchPath, "utf-8")).resolves.toContain("sandbox")

    await promoteDiff(repo, sandbox)
    expect(await readText(path.join(repo, "README.md"))).toBe("sandbox\n")
    expect(await readText(path.join(repo, "tools/test/unit/improved.test.ts"))).toBe("// improved\n")
    const promoted = await loadSandbox(repo, sandbox.id)
    expect(promoted.status).toBe("promoted")
  })

  it("runs a step inside the sandbox and writes a run summary", async () => {
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "node" })
    const adapter: LabAdapter = {
      id: "probe",
      description: "probe",
      categories: { probe: { description: "probe", paths: [] } },
      profiles: {},
      defaultExclude: [],
      plan: () => [
        {
          label: "probe",
          command: process.execPath,
          args: ["-e", "console.log('probe-ok')"],
          timeoutMs: 5000,
        },
      ],
    }

    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter,
      selection: { category: "probe" },
    })
    expect(summary.status).toBe("passed")
    expect(summary.steps[0]?.outputTail).toContain("probe-ok")
    expect(summary.totals.total).toBe(0)
    await expect(fs.lstat(summary.summaryPath)).resolves.toBeDefined()

    const failing: LabAdapter = {
      ...adapter,
      plan: () => [{ label: "failing", command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 5000 }],
    }
    const failed = await runLab({
      projectRoot: repo,
      sandbox,
      adapter: failing,
      selection: { category: "probe" },
    })
    expect(failed.status).toBe("failed")
    expect(failed.steps[0]?.code).toBe(3)
  })

  it("runs a real vitest category through the integrity adapter and excludes mutation files", async () => {
    await writeRepoFile("vitest.config.ts", "export default {}\n")
    await writeRepoFile(
      "tools/lab/vitest.config.lab.ts",
      await fs.readFile(repoPath("tools/lab/vitest.config.lab.ts"), "utf-8"),
    )
    await writeRepoFile(
      "tools/test/unit/sample.test.ts",
      'import { expect, it } from "vitest"\n\nit("adds", () => expect(1 + 1).toBe(2))\n',
    )
    await writeRepoFile(
      "tools/test/unit/broken-mutation.test.ts",
      'import { expect, it } from "vitest"\n\nit("must not run", () => expect(1).toBe(2))\n',
    )
    await writeRepoFile(".gitignore", "node_modules/\n")
    git(["add", "-A"])
    git(["commit", "-m", "vitest fixture"])
    await fs.symlink(
      path.join(repoRootDir(), "node_modules"),
      path.join(repo, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const sandbox = await createSandbox({ projectRoot: repo, adapter: "integrity" })
    const adapter = await selectAdapter(repo, "integrity")
    const summary = await runLab({
      projectRoot: repo,
      sandbox,
      adapter,
      selection: { category: "unit" },
    })
    expect(summary.status).toBe("passed")
    expect(summary.steps[0]?.tests?.total).toBe(1)
    expect(summary.steps[0]?.tests?.passed).toBe(1)
    expect(summary.totals.total).toBe(1)

    const gated = await speckitLab.execute(
      { subcommand: "run", id: sandbox.id, profile: "soak" },
      mockContext(repo),
    )
    expect(gated.title).toBe("Confirm Lab Run")
  })

  it("captures process output and exits without leaving a child behind", async () => {
    const result = await runLabProcess(process.execPath, ["-e", "console.log('runner-ok')"], {
      cwd: repo,
      timeoutMs: 5000,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("runner-ok")
    expect(result.timedOut).toBe(false)
  })

  it("rejects a directory that is not a git repository", async () => {
    const plain = await createTempWorktree()
    try {
      await expect(createSandbox({ projectRoot: plain, adapter: "node" })).rejects.toThrow(/git repository/)
    } finally {
      await destroyTempWorktree(plain)
    }
  })
})

describe("speckit-lab tool", () => {
  it("creates, inspects, diffs, promotes and destroys a sandbox", async () => {
    const created = await speckitLab.execute({ subcommand: "create", adapter: "node" }, mockContext(repo))
    expect(created.title).toBe("Lab Sandbox Created")
    const sandboxId = created.metadata?.sandboxId as string
    expect(sandboxId).toBeTruthy()

    const status = await speckitLab.execute({ subcommand: "status", id: sandboxId }, mockContext(repo))
    expect(status.output).toContain(sandboxId)
    expect(status.output).toContain("The sandbox is clean.")

    const sandbox = await loadSandbox(repo, sandboxId)
    await fs.writeFile(path.join(sandbox.sandboxRoot, "README.md"), "from tool\n", "utf-8")
    const diff = await speckitLab.execute({ subcommand: "diff", id: sandboxId }, mockContext(repo))
    expect(diff.title).toBe("Lab Diff")
    expect(diff.output).toContain("README.md")

    const unconfirmed = await speckitLab.execute({ subcommand: "promote", id: sandboxId }, mockContext(repo))
    expect(unconfirmed.title).toBe("Confirm Promote")
    const promoted = await speckitLab.execute(
      { subcommand: "promote", id: sandboxId, confirmed: true },
      mockContext(repo),
    )
    expect(promoted.title).toBe("Lab Patch Promoted")
    expect(await readText(path.join(repo, "README.md"))).toBe("from tool\n")

    const destroyed = await speckitLab.execute(
      { subcommand: "destroy", id: sandboxId, confirmed: true },
      mockContext(repo),
    )
    expect(destroyed.title).toBe("Lab Sandbox Destroyed")
  })
})
