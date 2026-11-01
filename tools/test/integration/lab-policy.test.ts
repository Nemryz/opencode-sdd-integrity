import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"
import { execFileSync } from "node:child_process"
import speckitLab from "../../speckit-lab"
import { isLabDisabled, labPolicyFile, setLabDisabled, LAB_DISABLED_ENV } from "../../lab/core/policy"
import { readRegistry } from "../../lab/core/registry"
import { readLabAudit } from "../../lab/core/audit"

let repo: string

beforeEach(async () => {
  repo = await createTempWorktree()
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.email", "policy@example.com"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.name", "Policy Tester"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf-8")
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "policy-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }), "utf-8")
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["commit", "-qm", "policy base"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
})

afterEach(async () => {
  await destroyTempWorktree(repo)
  delete process.env[LAB_DISABLED_ENV]
})

async function auditKinds(): Promise<string[]> {
  const records = await readLabAudit(repo).catch(() => [])
  return records.map((record) => record.kind)
}

describe("lab kill switch through the tool", () => {
  it("demands confirmation before any policy change lands on disk", async () => {
    const prompted = await speckitLab.execute({ subcommand: "disable" }, mockContext(repo))
    expect(prompted.title).toBe("Confirm Lab Kill Switch")
    expect(await isLabDisabled(repo)).toBe(false)
    expect(await fs.access(labPolicyFile(repo)).then(() => true, () => false)).toBe(false)

    const promptedEnable = await speckitLab.execute({ subcommand: "enable" }, mockContext(repo))
    expect(promptedEnable.title).toBe("Confirm Lab Kill Switch")
  })

  it("turns the switch on and leaves create and run as safe no-ops", async () => {
    const disabled = await speckitLab.execute({ subcommand: "disable", confirmed: true }, mockContext(repo))
    expect(disabled.title).toBe("Lab Disabled")
    expect(await isLabDisabled(repo)).toBe(true)
    expect((await auditKinds()).filter((kind) => kind === "lab_policy")).toHaveLength(1)

    const created = await speckitLab.execute({ subcommand: "create" }, mockContext(repo))
    expect(created.title).toBe("Lab Disabled")
    expect((created.metadata as Record<string, unknown>).safeNoOp).toBe(true)
    expect(await readRegistry(repo)).toEqual({ version: 1, sandboxes: [] })

    const ran = await speckitLab.execute({ subcommand: "run" }, mockContext(repo))
    expect(ran.title).toBe("Lab Disabled")
    expect((ran.metadata as Record<string, unknown>).safeNoOp).toBe(true)
  })

  it("re-enables only after confirmation and create works again", async () => {
    await setLabDisabled(repo, true)

    const enabled = await speckitLab.execute({ subcommand: "enable", confirmed: true }, mockContext(repo))
    expect(enabled.title).toBe("Lab Enabled")
    expect(await isLabDisabled(repo)).toBe(false)
    expect((await auditKinds()).at(-1)).toBe("lab_policy")

    const created = await speckitLab.execute({ subcommand: "create" }, mockContext(repo))
    expect(created.title).not.toBe("Lab Disabled")
    expect(await readRegistry(repo).then((registry) => registry.sandboxes)).toHaveLength(1)
  })

  it("lets the kill switch environment variable beat a permissive policy file", async () => {
    await setLabDisabled(repo, false)
    process.env[LAB_DISABLED_ENV] = "1"

    expect(await isLabDisabled(repo)).toBe(true)
    const created = await speckitLab.execute({ subcommand: "create" }, mockContext(repo))
    expect(created.title).toBe("Lab Disabled")

    delete process.env[LAB_DISABLED_ENV]
    const after = await speckitLab.execute({ subcommand: "create" }, mockContext(repo))
    expect(after.title).not.toBe("Lab Disabled")
  })

  it("treats a corrupted policy file as a permissive one so the switch fails open", async () => {
    await fs.mkdir(path.dirname(labPolicyFile(repo)), { recursive: true })
    await fs.writeFile(labPolicyFile(repo), "{not json", "utf-8")
    expect(await isLabDisabled(repo)).toBe(false)
    expect((await speckitLab.execute({ subcommand: "disable", confirmed: true }, mockContext(repo))).title).toBe("Lab Disabled")
  })
})
