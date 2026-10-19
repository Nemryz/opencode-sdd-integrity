import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import doomLoopPlugin, {
  DEFAULT_DOOM_LOOP_OPTIONS,
  DoomLoopTracker,
  blockMessage,
  fingerprintCall,
  isV1Failure,
  isV2Failure,
  parseDoomLoopOptions,
} from "../../plugins/speckit-doom-loop"

type HookCallback = (input: any, output?: any) => Promise<void> | void

type CapturedPlugin = {
  before: HookCallback | null
  after: HookCallback | null
  synthetics: Array<{ sessionID: string; text: string }>
}

// Builds the smallest V2 context that captures the hooks and the synthetic messages a plugin emits.
function fakeContext(projectRoot: string, captured: CapturedPlugin, options: Record<string, unknown> = {}) {
  return {
    options,
    location: {
      directory: projectRoot,
      project: { id: "test-project", directory: projectRoot, canonical: projectRoot },
    },
    session: {
      synthetic: async (input: { sessionID: string; text: string }) => {
        captured.synthetics.push(input)
      },
    },
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        if (name === "execute.before") captured.before = callback
        if (name === "execute.after") captured.after = callback
        return { dispose: async () => {} }
      },
    },
  }
}

// Sends one failed tool call through the V2 after hook the way the runtime reports an error.
function failureEvent(tool: string, input: unknown, sessionID = "session-1") {
  return {
    tool,
    sessionID,
    agent: "build",
    messageID: "message-1",
    id: "call-1",
    input,
    status: "error" as const,
    error: { message: "boom" },
  }
}

// Sends one successful tool call through the V2 after hook.
function completedEvent(tool: string, input: unknown, metadata?: Record<string, unknown>, sessionID = "session-1") {
  return {
    tool,
    sessionID,
    agent: "build",
    messageID: "message-1",
    id: "call-1",
    input,
    status: "completed" as const,
    result: { content: "ok", metadata },
  }
}

let worktree: string

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "doom-loop-"))
  await fs.mkdir(path.join(worktree, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  await fs.rm(worktree, { recursive: true, force: true })
})

async function loadV2Hooks(options: Record<string, unknown> = {}): Promise<CapturedPlugin> {
  const captured: CapturedPlugin = { before: null, after: null, synthetics: [] }
  await doomLoopPlugin.setup(fakeContext(worktree, captured, options) as any)
  return captured
}

async function loadV1Hooks(options?: Record<string, unknown>): Promise<Record<string, HookCallback>> {
  return (await doomLoopPlugin.server!({ worktree } as any, options)) as unknown as Record<string, HookCallback>
}

describe("doom loop fingerprinting", () => {
  it("treats argument order as irrelevant", () => {
    expect(fingerprintCall("bash", { command: "ls", cwd: "/x" })).toBe(fingerprintCall("bash", { cwd: "/x", command: "ls" }))
  })

  it("sorts nested object keys as well", () => {
    expect(fingerprintCall("edit", { a: { b: 1, c: 2 } })).toBe(fingerprintCall("edit", { a: { c: 2, b: 1 } }))
  })

  it("separates different values and different tools", () => {
    expect(fingerprintCall("bash", { command: "ls" })).not.toBe(fingerprintCall("bash", { command: "ls -la" }))
    expect(fingerprintCall("bash", { command: "ls" })).not.toBe(fingerprintCall("shell", { command: "ls" }))
  })

  it("survives circular input with a stable placeholder", () => {
    const circular: Record<string, unknown> = { command: "ls" }
    circular.self = circular
    const first = fingerprintCall("bash", circular)
    const second = fingerprintCall("bash", circular)
    expect(first).toBe(second)
    expect(first).toContain("[circular]")
  })

  it("caps the serialized length while keeping the tool prefix", () => {
    const fingerprint = fingerprintCall("bash", { command: "x".repeat(10_000) })
    expect(fingerprint.startsWith("bash:")).toBe(true)
    expect(fingerprint.length).toBeLessThanOrEqual("bash:".length + 4096)
  })

  it("keeps absent and primitive inputs stable", () => {
    expect(fingerprintCall("t", undefined)).toBe(fingerprintCall("t", undefined))
    expect(fingerprintCall("t", 7)).toBe(fingerprintCall("t", 7))
    expect(fingerprintCall("t", "7")).not.toBe(fingerprintCall("t", 7))
  })
})

describe("doom loop failure classifiers", () => {
  it.each([
    ["error status", { status: "error", error: { message: "boom" } }, true],
    ["clean completion", { status: "completed", result: { content: "ok" } }, false],
    ["completed with non zero exit", { status: "completed", result: { metadata: { exit: 1 } } }, true],
    ["completed with zero exit", { status: "completed", result: { metadata: { exit: 0 } } }, false],
    ["completed with error metadata", { status: "completed", result: { metadata: { error: "boom" } } }, true],
    ["completed with an error title", { status: "completed", result: { metadata: { title: "Error" } } }, true],
    ["completed with a normal title", { status: "completed", result: { metadata: { title: "Phase: impl" } } }, false],
    ["missing event", undefined, false],
    ["empty event", {}, false],
  ])("V2 classifies %s", (_label, event, expected) => {
    expect(isV2Failure(event)).toBe(expected)
  })

  it.each([
    ["error metadata", { metadata: { error: "boom" } }, true],
    ["non zero exit", { metadata: { exit: 127 } }, true],
    ["error title", { metadata: { title: "Error" } }, true],
    ["normal title", { metadata: { title: "Status: ok" } }, false],
    ["empty metadata", { metadata: {} }, false],
    ["missing output", undefined, false],
  ])("V1 classifies %s", (_label, output, expected) => {
    expect(isV1Failure(output)).toBe(expected)
  })
})

describe("doom loop option parsing", () => {
  it.each([
    ["undefined", undefined, DEFAULT_DOOM_LOOP_OPTIONS],
    ["null", null, DEFAULT_DOOM_LOOP_OPTIONS],
    ["a string", "text", DEFAULT_DOOM_LOOP_OPTIONS],
    ["an array", [], DEFAULT_DOOM_LOOP_OPTIONS],
    ["an empty object", {}, DEFAULT_DOOM_LOOP_OPTIONS],
    ["a disable flag", { enabled: false }, { ...DEFAULT_DOOM_LOOP_OPTIONS, enabled: false }],
    [
      "valid overrides",
      { warnAt: 2, blockAt: 4, resetAfterMs: 500, maxEntries: 10 },
      { enabled: true, warnAt: 2, blockAt: 4, resetAfterMs: 500, maxEntries: 10 },
    ],
    [
      "invalid numbers",
      { warnAt: 0, blockAt: -3, resetAfterMs: 0, maxEntries: 0 },
      DEFAULT_DOOM_LOOP_OPTIONS,
    ],
    [
      "a block threshold below the warning threshold",
      { warnAt: 6, blockAt: 2 },
      { ...DEFAULT_DOOM_LOOP_OPTIONS, warnAt: 6, blockAt: 7 },
    ],
    [
      "fractional counts",
      { warnAt: 2.9, blockAt: 4.7 },
      { ...DEFAULT_DOOM_LOOP_OPTIONS, warnAt: 2, blockAt: 4 },
    ],
    [
      "non finite numbers",
      { warnAt: Number.NaN, blockAt: Number.POSITIVE_INFINITY, resetAfterMs: Number.NEGATIVE_INFINITY },
      DEFAULT_DOOM_LOOP_OPTIONS,
    ],
    [
      "numeric strings",
      { warnAt: "3", blockAt: "5", resetAfterMs: "1000", maxEntries: "4" },
      DEFAULT_DOOM_LOOP_OPTIONS,
    ],
    ["a non boolean enabled flag", { enabled: "yes" }, DEFAULT_DOOM_LOOP_OPTIONS],
  ])("reads %s", (_label, raw, expected) => {
    expect(parseDoomLoopOptions(raw)).toEqual(expected)
  })
})

describe("doom loop tracker", () => {
  const options = { ...DEFAULT_DOOM_LOOP_OPTIONS, warnAt: 3, blockAt: 5, resetAfterMs: 60_000, maxEntries: 256 }

  it("reports the warning exactly once when the streak reaches the threshold", () => {
    const tracker = new DoomLoopTracker(options)
    expect(tracker.record("s1", "f", true).warn).toBe(false)
    expect(tracker.record("s1", "f", true).warn).toBe(false)
    const third = tracker.record("s1", "f", true)
    expect(third.warn).toBe(true)
    expect(third.failures).toBe(3)
    expect(tracker.record("s1", "f", true).warn).toBe(false)
  })

  it("blocks inspection once the streak reaches the block threshold", () => {
    const tracker = new DoomLoopTracker(options)
    for (let i = 0; i < 4; i++) tracker.record("s1", "f", true)
    expect(tracker.inspect("s1", "f", "bash").kind).toBe("allow")

    tracker.record("s1", "f", true)
    const decision = tracker.inspect("s1", "f", "bash")
    expect(decision.kind).toBe("block")
    if (decision.kind === "block") {
      expect(decision.message).toContain("5 times")
      expect(decision.message).toContain("bash")
    }
  })

  it("clears the streak after a successful call", () => {
    const tracker = new DoomLoopTracker(options)
    tracker.record("s1", "f", true)
    tracker.record("s1", "f", true)
    expect(tracker.record("s1", "f", false).failures).toBe(0)
    expect(tracker.record("s1", "f", true).warn).toBe(false)
    expect(tracker.record("s1", "f", true).warn).toBe(false)
  })

  it("keeps sessions and fingerprints isolated", () => {
    const tracker = new DoomLoopTracker(options)
    tracker.record("s1", "f", true)
    tracker.record("s1", "f", true)
    expect(tracker.record("s1", "f", true).warn).toBe(true)

    tracker.record("s2", "f", true)
    expect(tracker.record("s2", "f", true).warn).toBe(false)
    expect(tracker.record("s2", "g", true).warn).toBe(false)
    expect(tracker.inspect("s2", "f", "bash").kind).toBe("allow")
  })

  it("expires streaks after the reset window", () => {
    const clock = { t: 1000 }
    const tracker = new DoomLoopTracker({ ...options, resetAfterMs: 100 }, () => clock.t)
    for (let i = 0; i < 5; i++) {
      clock.t += 10
      tracker.record("s1", "f", true)
    }
    expect(tracker.inspect("s1", "f", "bash").kind).toBe("block")

    clock.t += 1000
    expect(tracker.inspect("s1", "f", "bash").kind).toBe("allow")
    clock.t += 10
    expect(tracker.record("s1", "f", true).failures).toBe(1)
  })

  it("caps the bucket by evicting the oldest streak", () => {
    const clock = { t: 1000 }
    const tracker = new DoomLoopTracker({ ...options, maxEntries: 2 }, () => clock.t)
    clock.t += 1
    tracker.record("s1", "a", true)
    clock.t += 1
    tracker.record("s1", "b", true)
    clock.t += 1
    tracker.record("s1", "c", true)

    // The third streak pushes the oldest one out while the recent survivors keep counting.
    clock.t += 1
    expect(tracker.record("s1", "b", true).failures).toBe(2)
    clock.t += 1
    expect(tracker.record("s1", "a", true).failures).toBe(1)
  })

  it("describes the block action in the error message", () => {
    expect(blockMessage("bash", 5)).toContain("ask the user")
    expect(blockMessage("bash", 5)).toContain("5 times")
  })
})

describe("speckit-doom-loop V2 entrypoint", () => {
  it("registers both hooks and writes the load marker", async () => {
    const captured = await loadV2Hooks()
    expect(captured.before).not.toBeNull()
    expect(captured.after).not.toBeNull()

    const state = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "plugins-state.json"), "utf-8"))
    expect(state["speckit-doom-loop"]?.loadedAt).toBeDefined()
  })

  it("warns through a synthetic message when the same call fails three times", async () => {
    const captured = await loadV2Hooks()
    const input = { command: "npm test" }

    await captured.after!(failureEvent("bash", input))
    await captured.after!(failureEvent("bash", input))
    expect(captured.synthetics).toHaveLength(0)

    await captured.after!(failureEvent("bash", input))
    expect(captured.synthetics).toHaveLength(1)
    expect(captured.synthetics[0].text).toContain('"bash"')
    expect(captured.synthetics[0].text).toContain("3 times")
    expect(captured.synthetics[0].sessionID).toBe("session-1")

    await captured.after!(failureEvent("bash", input))
    expect(captured.synthetics).toHaveLength(1)
  })

  it("blocks the identical call after the fifth failure and keeps other calls open", async () => {
    const captured = await loadV2Hooks()
    const input = { command: "npm test" }
    for (let i = 0; i < 5; i++) {
      await captured.after!(failureEvent("bash", input))
    }

    const identical = { tool: "bash", sessionID: "session-1", input }
    await expect(captured.before!(identical)).rejects.toThrow("Doom loop blocked")
    await expect(captured.before!({ tool: "bash", sessionID: "session-1", input: { command: "npm test -- --fix" } })).resolves.toBeUndefined()
    await expect(captured.before!({ tool: "read", sessionID: "session-1", input })).resolves.toBeUndefined()
  })

  it("clears the streak when the same call finally succeeds", async () => {
    const captured = await loadV2Hooks()
    const input = { command: "npm test" }

    await captured.after!(failureEvent("bash", input))
    await captured.after!(failureEvent("bash", input))
    await captured.after!(completedEvent("bash", input))
    await captured.after!(failureEvent("bash", input))
    await captured.after!(failureEvent("bash", input))

    expect(captured.synthetics).toHaveLength(0)
  })

  it("counts a completed call with a non zero exit code as a failure", async () => {
    const captured = await loadV2Hooks()
    const input = { command: "npm test" }

    await captured.after!(completedEvent("bash", input, { exit: 1 }))
    await captured.after!(completedEvent("bash", input, { exit: 1 }))
    await captured.after!(completedEvent("bash", input, { exit: 1 }))

    expect(captured.synthetics).toHaveLength(1)
  })

  it("keeps sessions apart through the hooks", async () => {
    const captured = await loadV2Hooks()
    const input = { command: "npm test" }

    for (let i = 0; i < 3; i++) {
      await captured.after!(failureEvent("bash", input, "session-a"))
    }
    await captured.after!(failureEvent("bash", input, "session-b"))

    expect(captured.synthetics).toHaveLength(1)
    expect(captured.synthetics[0].sessionID).toBe("session-a")
    await expect(captured.before!({ tool: "bash", sessionID: "session-b", input })).resolves.toBeUndefined()
  })

  it("registers no hooks when the plugin is disabled", async () => {
    const captured = await loadV2Hooks({ enabled: false })
    expect(captured.before).toBeNull()
    expect(captured.after).toBeNull()

    const state = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "plugins-state.json"), "utf-8"))
    expect(state["speckit-doom-loop"]?.loadedAt).toBeDefined()
  })

  it("honors custom thresholds from the plugin options", async () => {
    const captured = await loadV2Hooks({ warnAt: 1, blockAt: 2 })
    const input = { command: "flaky" }

    await captured.after!(failureEvent("bash", input))
    expect(captured.synthetics).toHaveLength(1)

    await captured.after!(failureEvent("bash", input))
    await expect(captured.before!({ tool: "bash", sessionID: "session-1", input })).rejects.toThrow("Doom loop blocked")
  })
})

describe("speckit-doom-loop V1 server", () => {
  it("registers the hooks and writes the load marker", async () => {
    const hooks = await loadV1Hooks()
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")

    const state = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "plugins-state.json"), "utf-8"))
    expect(state["speckit-doom-loop"]?.loadedAt).toBeDefined()
  })

  it("delivers the warning through the system prompt once", async () => {
    const hooks = await loadV1Hooks()
    const input = { command: "npm test" }
    const toolInput = { tool: "bash", sessionID: "s1", callID: "c1", args: input }
    const toolOutput = { title: "Error", output: "boom", metadata: { error: "boom" } }

    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(toolInput, toolOutput)
    }

    const first = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1" }, first)
    expect(first.system.some((entry) => entry.includes("Doom loop warning"))).toBe(true)

    const second = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1" }, second)
    expect(second.system).toHaveLength(0)
  })

  it("blocks the identical call after the fifth failure", async () => {
    const hooks = await loadV1Hooks()
    const input = { command: "npm test" }
    const toolInput = { tool: "bash", sessionID: "s1", callID: "c1", args: input }
    const toolOutput = { title: "Error", output: "boom", metadata: { title: "Error" } }

    for (let i = 0; i < 5; i++) {
      await hooks["tool.execute.after"]!(toolInput, toolOutput)
    }

    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s1", callID: "c9" }, { args: input }),
    ).rejects.toThrow("Doom loop blocked")
    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s1", callID: "c9" }, { args: { command: "other" } }),
    ).resolves.toBeUndefined()
  })

  it("registers no hooks when the plugin is disabled", async () => {
    const hooks = await loadV1Hooks({ enabled: false })
    expect(Object.keys(hooks)).toHaveLength(0)
  })
})
