import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const EXAMPLE_PATH = repoPath("opencode.jsonc.example")

describe("opencode.jsonc.example approval gate", () => {
  let config: Record<string, any>

  beforeAll(async () => {
    config = JSON.parse(await fs.readFile(EXAMPLE_PATH, "utf-8"))
  })

  it("does not gate custom tools through the permission config", () => {
    const supported = [
      "read", "edit", "glob", "grep", "bash", "task", "skill", "lsp",
      "question", "webfetch", "websearch", "external_directory", "doom_loop",
    ]
    for (const key of Object.keys(config.permission ?? {})) {
      expect(supported).toContain(key)
    }
  })

  it("keeps the external directory permission", () => {
    expect(config.permission?.external_directory?.["~/.config/opencode/**"]).toBe("allow")
  })

  it("sets a small_model for titles and summaries", () => {
    expect(typeof config.small_model).toBe("string")
    expect(config.small_model.length).toBeGreaterThan(0)
  })

  it("does not use local file paths in the plugin array", () => {
    const plugin = config.plugin
    if (plugin === undefined) return
    expect(Array.isArray(plugin)).toBe(true)
    for (const entry of plugin) {
      expect(typeof entry).toBe("string")
      expect(entry).not.toMatch(/^[.~]|[\\/]/)
    }
  })
})
