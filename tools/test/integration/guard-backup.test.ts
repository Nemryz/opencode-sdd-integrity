import { describe, it, expect, beforeEach, afterEach } from "vitest"
import guardTool from "../../speckit-guard"
import guardPlugin from "../../plugins/speckit-guard"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  countBackupsFor,
  expectSchemaValid,
  readProjectJson,
  writeProjectFile,
} from "../helpers/assertions"
import { GuardConfigSchema } from "../../plugins/speckit-guard"

let worktree: string
let ctx: ReturnType<typeof mockContext>

// Lists the checksum guarded backups that live in the worktree so rewrites can be counted.
async function backupFiles(): Promise<string[]> {
  const { default: fs } = await import("node:fs/promises")
  const path = await import("node:path")
  const dir = path.join(worktree, ".opencode", "backups")
  const files = await fs.readdir(dir).catch(() => [] as string[])
  return files.filter(file => file.endsWith(".bak"))
}

async function seedSession(): Promise<void> {
  await writeProjectFile(worktree, ".opencode/spec-memory/session.json", JSON.stringify({
    command: "/status",
    phase: "ready",
    featureDir: null,
    featureNumber: null,
    featureName: null,
    nextStep: "/spec <description>",
    lastResult: null,
    history: [],
  }))
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("guard.json backups", () => {
  it("guard tool keeps the previous config as a backup when it rewrites the file", async () => {
    await seedSession()
    await guardTool.execute({ subcommand: "on" } as never, ctx)
    const before = await countBackupsFor(worktree, ".opencode/guard.json")

    await guardTool.execute({ subcommand: "off", confirmed: true } as never, ctx)

    const after = await countBackupsFor(worktree, ".opencode/guard.json")
    expect(after).toBe(before + 1)

    // The live file must stay valid and reflect the change the tool reported.
    const config = await readProjectJson(worktree, ".opencode/guard.json")
    expectSchemaValid(GuardConfigSchema, config)
    expect((config as { enabled: boolean }).enabled).toBe(false)

    // The backup must hold the config as it was before the rewrite.
    const files = await backupFiles()
    expect(files.some(file => file.includes("guard"))).toBe(true)
  })

  it("guard plugin keeps a backup when repeated denials rewrite the config", async () => {
    await seedSession()
    const hooks = await guardPlugin.server({ worktree } as never)

    for (let attempt = 0; attempt < 2; attempt++) {
      await hooks["tool.execute.before"]!(
        { tool: "bash", sessionID: "s1", callID: `c${attempt}` } as never,
        { args: { command: "echo hi > .opencode/spec-memory/session.json" } } as never,
      ).catch(() => {})
    }

    expect(await countBackupsFor(worktree, ".opencode/guard.json")).toBeGreaterThan(0)

    const config = await readProjectJson(worktree, ".opencode/guard.json")
    expectSchemaValid(GuardConfigSchema, config)
    const denials = (config as { denials: unknown[] }).denials
    expect(Array.isArray(denials)).toBe(true)
    expect(denials.length).toBeGreaterThan(0)
  })
})