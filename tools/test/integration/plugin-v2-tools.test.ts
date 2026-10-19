import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createTempWorktree, destroyTempWorktree, removeDirWithRetry } from "../helpers/setup"
import speckitTools, { toPluginContent } from "../../plugins/speckit-tools"

type RegisteredTool = {
  name: string
  description: string
  input: any
  options?: { codemode?: boolean }
  execute: (input: any, context: any) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

const EXPECTED_TOOLS = [
  "speckit-approve",
  "speckit-audit",
  "speckit-clean",
  "speckit-complexity",
  "speckit-config",
  "speckit-delta",
  "speckit-evidence",
  "speckit-guard",
  "speckit-health",
  "speckit-mutation",
  "speckit-perf",
  "speckit-phase",
  "speckit-scaffold",
  "speckit-selfheal",
  "speckit-snapshot",
  "speckit-status",
  "speckit-validate",
]

// Builds the smallest V2 context that captures the tool registrations a plugin edits.
function fakeContext(projectRoot: string, registered: RegisteredTool[]) {
  return {
    location: {
      directory: projectRoot,
      project: { id: "test-project", directory: projectRoot, canonical: projectRoot },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        callback({ add: (tool) => { registered.push(tool) } })
      },
    },
  }
}

const runtimeContext = {
  sessionID: "session-1",
  messageID: "message-1",
  agent: "build",
  id: "call-1",
  signal: new AbortController().signal,
  progress: () => {},
}

let worktree: string
let registered: RegisteredTool[]
const extras: string[] = []

function toolNamed(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`missing registered tool ${name}`)
  return tool
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  registered = []
  await speckitTools.setup(fakeContext(worktree, registered) as any)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
  for (const dir of extras.splice(0)) {
    await removeDirWithRetry(dir)
  }
})

describe("speckit-tools V2 registration", () => {
  it("registers every speckit tool as a direct tool with a description and an object schema", () => {
    expect(registered.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
    for (const tool of registered) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.input.type).toBe("object")
      expect(tool.input.properties).toBeDefined()
      // Direct exposure keeps the tools callable outside the code mode catalog on OpenCode 2.
      expect(tool.options).toEqual({ codemode: false })
    }
  })

  it("lists only the required arguments in the schema", () => {
    const status = toolNamed(registered, "speckit-status")
    expect(status.input.required ?? []).not.toContain("confirmed")

    const complexity = toolNamed(registered, "speckit-complexity")
    expect(complexity.input.required).toContain("taskDescription")
    expect(complexity.input.required).not.toContain("filesAffected")
  })

  it("runs a tool against the plugin project root", async () => {
    const status = toolNamed(registered, "speckit-status")
    const result = await status.execute({ confirmed: true }, runtimeContext)

    expect(result.content).toContain("No features yet")
    expect(result.metadata?.title).toBe("Status: 0 feature(s)")
    expect(result.metadata?.featureCount).toBe(0)
  })

  it("keeps the error fields of a tool result", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-v2-tools-bare-"))
    extras.push(bare)
    const bareRegistered: RegisteredTool[] = []
    await speckitTools.setup(fakeContext(bare, bareRegistered) as any)

    const status = toolNamed(bareRegistered, "speckit-status")
    const result = await status.execute({}, runtimeContext)

    expect(result.content).toContain("Not a valid project directory")
    expect(result.metadata?.title).toBe("Error")
  })

  it("turns a missing required argument into an error string", async () => {
    const complexity = toolNamed(registered, "speckit-complexity")
    const result = await complexity.execute({}, runtimeContext)

    expect(result.content).toMatch(/^speckit-complexity:/)
    expect(result.metadata?.error).toBeDefined()
  })

  it("ignores arguments that are not part of the schema", async () => {
    const status = toolNamed(registered, "speckit-status")
    const result = await status.execute({ confirmed: true, unexpected: "value" }, runtimeContext)

    expect(result.content).toContain("No features yet")
  })

  it("keeps registered tool metadata free of undefined values", async () => {
    const selfheal = toolNamed(registered, "speckit-selfheal")
    const result = await selfheal.execute({ fix: false }, runtimeContext)

    expect(result.metadata).toBeDefined()
    expect(JSON.parse(JSON.stringify(result.metadata))).toStrictEqual(result.metadata)
  })
})

describe("toPluginContent metadata sanitization", () => {
  it("drops undefined values that would stall the V2 runtime part", () => {
    const result = toPluginContent({
      title: "Stub",
      output: "out",
      metadata: { total: 1, ghost: undefined, nested: { gone: undefined, kept: "x" }, list: [undefined, 2] },
    })

    expect(result.content).toBe("out")
    expect(result.metadata).toEqual({ total: 1, nested: { kept: "x" }, list: [null, 2], title: "Stub" })
    expect("ghost" in (result.metadata ?? {})).toBe(false)
    expect(JSON.parse(JSON.stringify(result.metadata))).toStrictEqual(result.metadata)
  })

  it("keeps clean metadata intact and never overwrites an existing title", () => {
    const result = toPluginContent({ title: "Stub", output: "o", metadata: { a: "b", title: "original" } })

    expect(result.metadata).toEqual({ a: "b", title: "original" })
  })

  it("falls back to the raw metadata when serialization fails", () => {
    const meta: Record<string, unknown> = {}
    meta.self = meta

    const result = toPluginContent({ output: "o", metadata: meta })

    expect(result.metadata).toBe(meta)
  })

  it("returns the string form and the metadata-free shape unchanged", () => {
    expect(toPluginContent("plain")).toEqual({ content: "plain" })
    expect(toPluginContent({ output: "only" })).toEqual({ content: "only" })
  })
})
