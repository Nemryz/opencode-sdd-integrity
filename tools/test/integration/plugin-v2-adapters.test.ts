import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import guardPlugin from "../../plugins/speckit-guard"
import perfmonPlugin from "../../plugins/speckit-perfmon"

type HookCallback = (event: any) => Promise<void> | void

type CapturedHooks = {
  toolBefore: HookCallback | null
  toolAfter: HookCallback | null
  permissionEvaluate: HookCallback | null
}

// Builds the smallest V2 context that captures the hooks a plugin registers.
function fakeContext(projectRoot: string, hooks: CapturedHooks) {
  return {
    location: {
      directory: projectRoot,
      project: { id: "test-project", directory: projectRoot, canonical: projectRoot },
    },
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        if (name === "execute.before") hooks.toolBefore = callback
        if (name === "execute.after") hooks.toolAfter = callback
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async (name: string, callback: HookCallback) => {
        if (name === "evaluate") hooks.permissionEvaluate = callback
        return { dispose: async () => {} }
      },
    },
  }
}

let worktree: string

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-v2-"))
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  await fs.rm(worktree, { recursive: true, force: true })
})

async function loadGuardHooks(): Promise<CapturedHooks> {
  const hooks: CapturedHooks = { toolBefore: null, toolAfter: null, permissionEvaluate: null }
  await guardPlugin.setup(fakeContext(worktree, hooks) as any)
  return hooks
}

async function loadPerfmonHooks(): Promise<CapturedHooks> {
  const hooks: CapturedHooks = { toolBefore: null, toolAfter: null, permissionEvaluate: null }
  await perfmonPlugin.setup(fakeContext(worktree, hooks) as any)
  return hooks
}

async function readGuardConfig(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "guard.json"), "utf-8"))
}

describe("speckit-guard V2 entrypoint", () => {
  it("registers tool and permission hooks and writes the load marker", async () => {
    const hooks = await loadGuardHooks()

    expect(hooks.toolBefore).not.toBeNull()
    expect(hooks.permissionEvaluate).not.toBeNull()
    const state = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "plugins-state.json"), "utf-8"))
    expect(state["speckit-guard"]?.loadedAt).toBeDefined()
  })

  it("blocks an edit of a protected file through the tool hook", async () => {
    const hooks = await loadGuardHooks()

    await expect(
      hooks.toolBefore!({ tool: "edit", input: { path: ".opencode/spec-memory/session.json" } }),
    ).rejects.toThrow("Guard blocked protected file")

    const config = await readGuardConfig()
    expect(config.stats.denied).toBe(1)
    expect(config.denials[0].file).toBe(".opencode/spec-memory/session.json")
  })

  it("blocks a write through the tool hook with the V2 path argument", async () => {
    const hooks = await loadGuardHooks()

    await expect(
      hooks.toolBefore!({ tool: "write", input: { path: ".opencode/guard.json" } }),
    ).rejects.toThrow("Guard blocked protected file")
  })

  it("allows an edit of a regular project file", async () => {
    const hooks = await loadGuardHooks()

    await expect(
      hooks.toolBefore!({ tool: "edit", input: { path: "src/app.ts" } }),
    ).resolves.toBeUndefined()
  })

  it("blocks a shell redirect to a protected file", async () => {
    const hooks = await loadGuardHooks()

    await expect(
      hooks.toolBefore!({ tool: "shell", input: { command: "echo hi > .opencode/spec-memory/config.json" } }),
    ).rejects.toThrow("Guard blocked protected file")
  })

  it("denies a protected edit through the permission hook", async () => {
    const hooks = await loadGuardHooks()
    const event: any = { action: "edit", resources: [".opencode/spec-memory/session.json"], effect: "ask" }

    await hooks.permissionEvaluate!(event)

    expect(event.effect).toBe("deny")
    expect(event.message).toContain("Always protected")
  })

  it("denies when any resource of a patch is protected", async () => {
    const hooks = await loadGuardHooks()
    const event: any = { action: "edit", resources: ["src/safe.ts", ".opencode/spec-memory/config.json"], effect: "ask" }

    await hooks.permissionEvaluate!(event)

    expect(event.effect).toBe("deny")
  })

  it("denies a shell redirect through the permission hook", async () => {
    const hooks = await loadGuardHooks()
    const event: any = { action: "shell", resources: ["echo hi > specs/001-a/spec.json"], effect: "ask" }

    await hooks.permissionEvaluate!(event)

    expect(event.effect).toBe("deny")
  })

  it("leaves unrelated permission evaluations untouched", async () => {
    const hooks = await loadGuardHooks()
    const event: any = { action: "read", resources: ["README.md"], effect: "allow" }

    await hooks.permissionEvaluate!(event)

    expect(event.effect).toBe("allow")
    expect(event.message).toBeUndefined()
  })

  it("records stats when an edit evaluation is allowed", async () => {
    const hooks = await loadGuardHooks()

    await hooks.permissionEvaluate!({ action: "edit", resources: ["src/app.ts"], effect: "ask" })

    const config = await readGuardConfig()
    expect(config.stats.asked).toBe(1)
    expect(config.stats.allowed).toBe(1)
  })

  it("stays inert when the guard is disabled", async () => {
    const configPath = path.join(worktree, ".opencode", "guard.json")
    await fs.writeFile(configPath, JSON.stringify({ version: 1, enabled: false }))
    const hooks = await loadGuardHooks()

    await expect(
      hooks.toolBefore!({ tool: "edit", input: { path: ".opencode/spec-memory/session.json" } }),
    ).resolves.toBeUndefined()

    const event: any = { action: "edit", resources: [".opencode/spec-memory/session.json"], effect: "ask" }
    await hooks.permissionEvaluate!(event)
    expect(event.effect).toBe("ask")
  })
})

describe("speckit-perfmon V2 entrypoint", () => {
  it("registers both tool hooks and writes the load marker", async () => {
    const hooks = await loadPerfmonHooks()

    expect(hooks.toolBefore).not.toBeNull()
    expect(hooks.toolAfter).not.toBeNull()
    const state = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "plugins-state.json"), "utf-8"))
    expect(state["speckit-perfmon"]?.loadedAt).toBeDefined()
  })

  it("records a completed call pair", async () => {
    const hooks = await loadPerfmonHooks()

    await hooks.toolBefore!({ id: "v2-call-1", tool: "some-tool", input: { path: "a.ts" } })
    await hooks.toolAfter!({ id: "v2-call-1", tool: "some-tool", status: "completed", result: {} })

    const perf = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "perf.json"), "utf-8"))
    expect(perf.stats).toHaveLength(1)
    expect(perf.stats[0].tool).toBe("some-tool")
    expect(perf.stats[0].calls).toBe(1)
  })

  it("ignores an after event with no matching before", async () => {
    const hooks = await loadPerfmonHooks()

    await hooks.toolAfter!({ id: "v2-orphan", tool: "some-tool", status: "completed", result: {} })

    await expect(fs.readFile(path.join(worktree, ".opencode", "perf.json"), "utf-8")).rejects.toThrow()
  })

  it("accumulates calls for the same tool", async () => {
    const hooks = await loadPerfmonHooks()

    await hooks.toolBefore!({ id: "v2-call-a", tool: "tool-a", input: {} })
    await hooks.toolAfter!({ id: "v2-call-a", tool: "tool-a", status: "completed", result: {} })
    await hooks.toolBefore!({ id: "v2-call-b", tool: "tool-a", input: {} })
    await hooks.toolAfter!({ id: "v2-call-b", tool: "tool-a", status: "error", error: { message: "boom" } })

    const perf = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "perf.json"), "utf-8"))
    expect(perf.stats).toHaveLength(1)
    expect(perf.stats[0].calls).toBe(2)
  })

  it("tracks different tools separately", async () => {
    const hooks = await loadPerfmonHooks()

    await hooks.toolBefore!({ id: "v2-call-c", tool: "tool-a", input: {} })
    await hooks.toolAfter!({ id: "v2-call-c", tool: "tool-a", status: "completed", result: {} })
    await hooks.toolBefore!({ id: "v2-call-d", tool: "tool-b", input: {} })
    await hooks.toolAfter!({ id: "v2-call-d", tool: "tool-b", status: "completed", result: {} })

    const perf = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "perf.json"), "utf-8"))
    expect(perf.stats.map((s: any) => s.tool).sort()).toEqual(["tool-a", "tool-b"])
  })
})
