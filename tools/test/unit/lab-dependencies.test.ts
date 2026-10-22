import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  planDependencyAction,
  readLockfile,
  type DependencyInput,
  type LockfileState,
} from "../../lab/core/dependencies"

let worktree: string | null = null

afterEach(async () => {
  if (worktree) {
    await destroyTempWorktree(worktree)
    worktree = null
  }
})

async function makeWorktree(): Promise<string> {
  worktree = await createTempWorktree()
  return worktree
}

function lockfile(file: string, hash: string): LockfileState {
  const manager = file.startsWith("pnpm")
    ? "pnpm"
    : file.startsWith("yarn")
      ? "yarn"
      : file.startsWith("bun")
        ? "bun"
        : "npm"
  return { file, manager, hash }
}

function input(overrides: Partial<DependencyInput>): DependencyInput {
  return {
    source: null,
    sandbox: null,
    current: undefined,
    sandboxHasNodeModules: false,
    sourceHasNodeModules: false,
    ...overrides,
  }
}

describe("lab lockfile inspection", () => {
  it("returns null when no supported lockfile exists", async () => {
    const root = await makeWorktree()
    expect(await readLockfile(root)).toBeNull()
  })

  it("hashes the lockfile and respects npm shrinkwrap precedence", async () => {
    const root = await makeWorktree()
    await fs.writeFile(path.join(root, "package-lock.json"), "package-lock\n", "utf-8")
    const packageLock = await readLockfile(root)
    expect(packageLock).toMatchObject({ file: "package-lock.json", manager: "npm" })
    expect(packageLock?.hash).toHaveLength(64)

    await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), "shrinkwrap\n", "utf-8")
    const shrinkwrap = await readLockfile(root)
    expect(shrinkwrap).toMatchObject({ file: "npm-shrinkwrap.json", manager: "npm" })
    expect(shrinkwrap?.hash).not.toBe(packageLock?.hash)
  })

  it("treats LF and CRLF lockfiles as the same content", async () => {
    const root = await makeWorktree()
    const file = path.join(root, "package-lock.json")
    await fs.writeFile(file, '{\n  "lockfileVersion": 3\n}\n', "utf-8")
    const lf = await readLockfile(root)
    await fs.writeFile(file, '{\r\n  "lockfileVersion": 3\r\n}\r\n', "utf-8")
    const crlf = await readLockfile(root)
    expect(crlf?.hash).toBe(lf?.hash)
  })

  it("detects supported package managers", async () => {
    const root = await makeWorktree()
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9'\n", "utf-8")
    expect(await readLockfile(root)).toMatchObject({ file: "pnpm-lock.yaml", manager: "pnpm" })
    await fs.rm(path.join(root, "pnpm-lock.yaml"))
    await fs.writeFile(path.join(root, "yarn.lock"), "# yarn\n", "utf-8")
    expect(await readLockfile(root)).toMatchObject({ file: "yarn.lock", manager: "yarn" })
  })
})

describe("lab dependency policy", () => {
  it("does nothing when there is no lockfile or dependency tree", () => {
    expect(planDependencyAction(input({})).action).toBe("ready")
  })

  it("links checkout dependencies when no lockfile is present", () => {
    expect(planDependencyAction(input({ sourceHasNodeModules: true })).action).toBe("link")
  })

  it("is ready when lockfiles match and same manager dependencies exist", () => {
    const lock = lockfile("package-lock.json", "a")
    expect(
      planDependencyAction(
        input({
          source: lock,
          sandbox: lock,
          sandboxHasNodeModules: true,
          sourceHasNodeModules: true,
        }),
      ).action,
    ).toBe("ready")
  })

  it("links matching dependencies when node_modules is missing in the sandbox", () => {
    const lock = lockfile("package-lock.json", "a")
    expect(
      planDependencyAction(
        input({
          source: lock,
          sandbox: lock,
          sourceHasNodeModules: true,
        }),
      ).action,
    ).toBe("link")
  })

  it("installs when lockfiles differ", () => {
    const decision = planDependencyAction(
      input({
        source: lockfile("package-lock.json", "checkout"),
        sandbox: lockfile("package-lock.json", "sandbox"),
        sandboxHasNodeModules: true,
        sourceHasNodeModules: true,
      }),
    )
    expect(decision.action).toBe("install")
    expect(decision.reason).toContain("differs")
  })

  it("installs when dependencies are missing and no source tree can be linked", () => {
    const lock = lockfile("pnpm-lock.yaml", "a")
    expect(planDependencyAction(input({ source: lock, sandbox: lock })).action).toBe("install")
  })

  it("keeps installed dependencies until their lockfile changes", () => {
    const lock = lockfile("package-lock.json", "a")
    const current = { strategy: "installed" as const, lockfile: lock.file, lockHash: lock.hash }
    expect(
      planDependencyAction(
        input({ source: lock, sandbox: lock, current, sandboxHasNodeModules: true }),
      ).action,
    ).toBe("ready")

    const changed = lockfile("package-lock.json", "b")
    expect(
      planDependencyAction(
        input({ source: lock, sandbox: changed, current, sandboxHasNodeModules: true }),
      ).action,
    ).toBe("install")
  })

  it("rejects a sandbox that lost the checkout lockfile", () => {
    const decision = planDependencyAction(input({ source: lockfile("package-lock.json", "a") }))
    expect(decision.action).toBe("error")
    expect(decision.reason).toContain("missing")
  })
})
