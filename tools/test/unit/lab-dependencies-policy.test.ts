import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installCommand, assertApprovedRegistries } from "../../lab/core/dependencies"
import type { LockfileState } from "../../lab/core/dependencies"

function lockfile(file: string): LockfileState {
  return { file, manager: "npm", hash: "0".repeat(64) }
}

describe("lab dependency offline installs", () => {
  it("adds the offline flag to the npm install argv when the policy asks for it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-dep-"))
    const command = await installCommand("npm", root, { offline: true })
    expect(command.args).toContain("--offline")
    expect(command.args).toContain("--ignore-scripts")
    const online = await installCommand("npm", root, { offline: false })
    expect(online.args).not.toContain("--offline")
  })

  it("adds the offline flag to pnpm, yarn and bun installs when requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-dep-"))
    for (const manager of ["pnpm", "yarn", "bun"] as const) {
      const command = await installCommand(manager, root, { offline: true })
      expect(command.args).toContain("--offline")
    }
  })
})

describe("lab approved registry allowlist", () => {
  it("accepts a lockfile whose resolved hosts are all approved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-reg-"))
    const file = "package-lock.json"
    await fs.writeFile(path.join(root, file), JSON.stringify({ packages: { "": { dependencies: { foo: "1.0.0" } }, "node_modules/foo": { version: "1.0.0", resolved: "https://registry.example/foo/-/foo-1.0.0.tgz", integrity: "sha512-abc" } } }))
    await expect(assertApprovedRegistries(lockfile(file), root, ["registry.example"])).resolves.toBeUndefined()
  })

  it("refuses a lockfile that resolves a package from an unapproved host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-reg-"))
    const file = "package-lock.json"
    await fs.writeFile(path.join(root, file), JSON.stringify({ packages: { "node_modules/foo": { version: "1.0.0", resolved: "https://evil.example/foo/-/foo-1.0.0.tgz" } } }))
    await expect(assertApprovedRegistries(lockfile(file), root, ["registry.example"])).rejects.toThrow(/unapproved registries/)
  })

  it("skips the check entirely when the allowlist is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-reg-"))
    const file = "package-lock.json"
    await fs.writeFile(path.join(root, file), "not json at all")
    await expect(assertApprovedRegistries(lockfile(file), root, [])).resolves.toBeUndefined()
  })
})
