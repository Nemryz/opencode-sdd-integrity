import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import configTool from "../../speckit-config"
import {
  configPath,
  pushCorruptionWarning,
  clearCorruptionWarnings,
  corruptionWarnings,
  DEFAULT_CONFIG,
} from "../../shared/types"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  clearCorruptionWarnings()
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  clearCorruptionWarnings()
  await destroyTempWorktree(worktree)
})

async function writeRawConfig(cfg: object): Promise<void> {
  await fs.mkdir(path.dirname(configPath(worktree)), { recursive: true })
  await fs.writeFile(configPath(worktree), JSON.stringify(cfg), "utf-8")
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configPath(worktree), "utf-8"))
}

const SHADOW_CONFIG = {
  defaultTechStack: "RealStack",
  lastUsedLanguage: null,
  expressMode: true,
  autoVersioning: true,
  preferences: {
    expressMode: "shadow-exp",
    autoVersioning: "shadow-auto",
    defaultTechStack: "shadow-stack",
  },
}

describe("config kill survivors - projectWarnings path", () => {
  it("returns Warning title with requiresConfirmation for a system directory root", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-warn-"))
    const sysRoot = path.join(base, "bin")
    await fs.mkdir(path.join(sysRoot, ".opencode", "spec-memory"), { recursive: true })
    try {
      const result = await configTool.execute({}, mockContext(sysRoot))
      expect(result.title).toBe("Warning")
      expect(result.output).toContain("system directory")
      expect(result.metadata?.requiresConfirmation).toBe(true)
      expect(Array.isArray(result.metadata?.warnings)).toBe(true)
      expect(result.metadata?.warnings).toHaveLength(1)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  // Depends on the Windows filesystem error message format.
  it.skipIf(process.platform !== "win32")("joins multiple warnings with a blank line separator", async () => {
    const rootBin = "C:\\bin"
    let exists = true
    try {
      await fs.access(rootBin)
    } catch {
      exists = false
    }
    if (exists) return
    let created = false
    try {
      await fs.mkdir(path.join(rootBin, ".opencode", "spec-memory"), { recursive: true })
      created = true
    } catch {
      return
    }
    try {
      const result = await configTool.execute({}, mockContext(rootBin))
      expect(result.title).toBe("Warning")
      expect(result.metadata?.warnings).toHaveLength(2)
      expect(result.output).toContain("\n\n")
    } finally {
      if (created) await fs.rm(rootBin, { recursive: true, force: true })
    }
  })
})

describe("config kill survivors - clearCorruptionWarnings", () => {
  it("clears pre-existing corruption warnings on execute", async () => {
    await configTool.execute({ key: "theme", value: "dark" }, ctx)
    pushCorruptionWarning("stale.json", "stale warning message")
    expect(corruptionWarnings.some(w => w.message === "stale warning message")).toBe(true)
    await configTool.execute({}, ctx)
    expect(corruptionWarnings.some(w => w.message === "stale warning message")).toBe(false)
  })
})

describe("config kill survivors - catch block", () => {
  it("returns Error title with config prefix when write validation fails", async () => {
    try {
      const result = await configTool.execute({ key: "theme", value: 123 as unknown as string }, ctx)
      expect(result.title).toBe("Error")
      expect(result.output.startsWith("config: ")).toBe(true)
      expect(result.output).toContain("validation failed")
      expect(String(result.metadata?.error)).toContain("validation failed")
    } finally {
      // readConfigWithRestore returns a shallow copy of DEFAULT_CONFIG, so the
      // invalid preference value mutated the shared global object. Clean it up.
      delete (DEFAULT_CONFIG.preferences as Record<string, string>).theme
    }
  })
})

describe("config kill survivors - read branches with shadowed preferences", () => {
  it("reads expressMode from cfg not preferences fallback", async () => {
    await writeRawConfig(SHADOW_CONFIG)
    const result = await configTool.execute({ key: "expressMode" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toBe("expressMode: true")
  })

  it("reads autoVersioning from cfg not preferences fallback", async () => {
    await writeRawConfig(SHADOW_CONFIG)
    const result = await configTool.execute({ key: "autoVersioning" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toBe("autoVersioning: true")
  })

  it("reads defaultTechStack from cfg not preferences fallback", async () => {
    await writeRawConfig(SHADOW_CONFIG)
    const result = await configTool.execute({ key: "defaultTechStack" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toBe("defaultTechStack: RealStack")
  })

  it("reads lastUsedLanguage through knownKeys fallback", async () => {
    await writeRawConfig({
      defaultTechStack: null,
      lastUsedLanguage: "de",
      expressMode: false,
      autoVersioning: false,
      preferences: {},
    })
    const result = await configTool.execute({ key: "lastUsedLanguage" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toBe("lastUsedLanguage: de")
  })
})

describe("config kill survivors - not set fallbacks", () => {
  it("shows (not set) when reading null defaultTechStack by key", async () => {
    const result = await configTool.execute({ key: "defaultTechStack" }, ctx)
    expect(result.title).toBe("Configuration read")
    expect(result.output).toBe("defaultTechStack: (not set)")
  })

  it("shows (not set) in update response when defaultTechStack set to null", async () => {
    const result = await configTool.execute({ defaultTechStack: null as unknown as string }, ctx)
    expect(`${result.title} :: ${result.output}`).toBe("Configuration updated :: defaultTechStack: (not set)")
    const raw = await readRawConfig()
    expect(raw.defaultTechStack).toBeNull()
  })
})

describe("config kill survivors - full display", () => {
  it("includes lastUsedLanguage value in full display", async () => {
    await writeRawConfig({
      defaultTechStack: null,
      lastUsedLanguage: "fr",
      expressMode: false,
      autoVersioning: false,
      preferences: {},
    })
    const result = await configTool.execute({}, ctx)
    expect(result.title).toBe("SDD Configuration")
    expect(result.output).toContain("lastUsedLanguage: fr")
  })

  it("shows (not set) for null lastUsedLanguage in full display", async () => {
    const result = await configTool.execute({}, ctx)
    expect(result.output).toContain("lastUsedLanguage: (not set)")
  })

  it("joins full display lines with pipe separator", async () => {
    const result = await configTool.execute({}, ctx)
    expect(result.output).toContain(" | ")
    expect(result.output.split(" | ").length).toBe(5)
  })

  it("reports preference count in full display", async () => {
    await configTool.execute({ key: "theme", value: "dark" }, ctx)
    const result = await configTool.execute({}, ctx)
    expect(result.output).toContain("preferences: 1 key(s)")
  })
})

describe("config kill survivors - persisted writes", () => {
  it("persists autoVersioning false to config file", async () => {
    await configTool.execute({ key: "autoVersioning", value: "true" }, ctx)
    await configTool.execute({ key: "autoVersioning", value: "false" }, ctx)
    const raw = await readRawConfig()
    expect(raw.autoVersioning).toBe(false)
  })

  it("persists defaultTechStack set via key=value to top level not preferences", async () => {
    await configTool.execute({ key: "defaultTechStack", value: "MyStack" }, ctx)
    const raw = await readRawConfig()
    expect(raw.defaultTechStack).toBe("MyStack")
    expect((raw.preferences as Record<string, string>).defaultTechStack).toBeUndefined()
  })

  it("does not update lastUsedLanguage when setting a non-language key", async () => {
    await configTool.execute({ key: "theme", value: "dark" }, ctx)
    const raw = await readRawConfig()
    expect(raw.lastUsedLanguage).toBeNull()
    expect((raw.preferences as Record<string, string>).theme).toBe("dark")
  })

  it("updates lastUsedLanguage when setting language key", async () => {
    await configTool.execute({ key: "language", value: "pt" }, ctx)
    const raw = await readRawConfig()
    expect(raw.lastUsedLanguage).toBe("pt")
  })

  it("echoes key and value in the update response", async () => {
    const result = await configTool.execute({ key: "theme", value: "dark" }, ctx)
    expect(result.title).toBe("Configuration updated")
    expect(result.output).toBe("theme: dark")
  })
})
