import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runLabProcess } from "../../lab/core/runner"
import { DEFAULT_LAB_ENV } from "../../lab/core/environment"
import { runLab } from "../../lab/core/run"
import { createSandbox, destroySandbox } from "../../lab/core/sandbox"
import { makeAttackRepo, destroyAttackRepo, git } from "../helpers/corpus"
import type { LabAdapter, LabSandbox } from "../../lab/core/types"

const HOOK_MARKER = "hook-marker.txt"
const INSTALL_MARKER = "install-marker.txt"

let repo: string | null = null
let sandbox: LabSandbox | null = null

afterEach(async () => {
  if (repo && sandbox) {
    await destroySandbox(repo, sandbox, true).catch(() => null)
    sandbox = null
  }
  if (repo) {
    await destroyAttackRepo(repo)
    repo = null
  }
})

async function hookFixture(root: string): Promise<void> {
  await fs.writeFile(path.join(root, "hook.txt"), "hook payload\n", "utf-8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "hook payload before activation"])
  const hookBody = `#!/bin/sh\nprintf fired > ${HOOK_MARKER}\nexit 1\n`
  await fs.mkdir(path.join(root, "hooks"), { recursive: true })
  await fs.writeFile(path.join(root, "hooks", "pre-commit"), hookBody, "utf-8")
  await fs.chmod(path.join(root, "hooks", "pre-commit"), 0o755)
  git(root, ["config", "core.hooksPath", "hooks"])
}

function probeAdapter(): LabAdapter {
  return {
    id: "probe",
    description: "probe",
    categories: { probe: { description: "probe", paths: [] } },
    profiles: {},
    defaultExclude: [],
    plan: () => [{ label: "probe", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5000 }],
  }
}

describe("corpus package scripts", () => {
  it("blocks a lifecycle script through the lab environment even when an install omits the flag", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-npm-"))
    try {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "corpus-scripts", version: "1.0.0", scripts: { postinstall: "node write-marker.js" } }, null, 2),
        "utf-8",
      )
      await fs.writeFile(path.join(dir, "write-marker.js"), 'require("node:fs").writeFileSync("install-marker.txt", "fired\\n")\n', "utf-8")

      // The lab env carries npm_config_ignore_scripts, so an ordinary install cannot fire the payload.
      const guarded = await runLabProcess("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 90_000 })
      expect(guarded.code).toBe(0)
      expect(await fs.access(path.join(dir, INSTALL_MARKER)).then(() => true, () => false)).toBe(false)

      // A step decides its own argv, so an explicit override wins and the payload shows the barrier is a layer.
      await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true })
      await fs.rm(path.join(dir, "package-lock.json"), { force: true })
      const overridden = await runLabProcess(
        "npm",
        ["install", "--ignore-scripts=false", "--no-audit", "--no-fund"],
        { cwd: dir, timeoutMs: 90_000 },
      )
      expect(overridden.code).toBe(0)
      expect(await fs.access(path.join(dir, INSTALL_MARKER)).then(() => true, () => false)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("ships the script and download kill variables as part of the default child environment", () => {
    expect(DEFAULT_LAB_ENV.npm_config_ignore_scripts).toBe("true")
    expect(DEFAULT_LAB_ENV.NPM_CONFIG_AUDIT).toBe("false")
    expect(DEFAULT_LAB_ENV.YARN_ENABLE_SCRIPTS).toBe("false")
    expect(DEFAULT_LAB_ENV.PUPPETEER_SKIP_DOWNLOAD).toBe("true")
  })
})

describe("corpus git hooks", () => {
  it("runs a commit in the checkout with hooks while a sandbox commit fires none", async () => {
    repo = await makeAttackRepo()
    await hookFixture(repo)
    sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })

    const sandboxCommit = await runLabProcess("git", ["commit", "--allow-empty", "-m", "sandbox"], {
      cwd: sandbox.sandboxRoot,
      timeoutMs: 20_000,
    })
    expect(sandboxCommit.code).toBe(0)
    expect(await fs.access(path.join(sandbox.sandboxRoot, HOOK_MARKER)).then(() => true, () => false)).toBe(false)

    const checkoutCommit = await runLabProcess("git", ["commit", "--allow-empty", "-m", "checkout"], {
      cwd: repo,
      timeoutMs: 20_000,
    })
    expect(checkoutCommit.code).not.toBe(0)
    expect(await fs.access(path.join(repo, HOOK_MARKER)).then(() => true, () => false)).toBe(true)
  })

  it("re-neutralizes a hooksPath that tampered work re-enabled between runs", async () => {
    repo = await makeAttackRepo()
    await hookFixture(repo)
    sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    await runLabProcess("git", ["config", "--worktree", "core.hooksPath", "hooks"], {
      cwd: sandbox.sandboxRoot,
      timeoutMs: 10_000,
    })

    await runLab({ projectRoot: repo, sandbox, adapter: probeAdapter(), selection: { category: "probe" } })

    const current = await runLabProcess("git", ["config", "--worktree", "--get", "core.hooksPath"], {
      cwd: sandbox.sandboxRoot,
      timeoutMs: 10_000,
    })
    expect(current.stdout.trim()).toBe(".opencode-lab-disabled-hooks")
  })
})
