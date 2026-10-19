import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import guardTool from "../../speckit-guard"
import { DEFAULT_CONFIG } from "../../plugins/speckit-guard"

describe("speckit-guard integration", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-integration-"))
    const opencodeDir = path.join(tmpDir, ".opencode")
    const specMemoryDir = path.join(opencodeDir, "spec-memory")
    await fs.mkdir(specMemoryDir, { recursive: true })
    await fs.writeFile(path.join(opencodeDir, "session.json"), "{}")
    await fs.writeFile(path.join(specMemoryDir, "constitution.md"), "# Constitution")
    const specsDir = path.join(tmpDir, "specs")
    await fs.mkdir(specsDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function runTool(args: any = {}) {
    return guardTool.execute(args, { worktree: tmpDir, sessionID: "test", callID: "test" })
  }

  describe("status subcommand", () => {
    it("returns guard status", async () => {
      const result = await runTool({ subcommand: "status" })
      expect(result.title).toBe("Guard Status")
      expect(result.output).toContain("Guard Status:")
      expect(result.output).toContain("Protected Files")
      expect(result.output).toContain("Statistics")
    })

    it("shows enabled by default", async () => {
      const result = await runTool({ subcommand: "status" })
      expect(result.output).toContain("ENABLED")
    })

    it("protects evidence.json when upgrading a v1 config", async () => {
      const legacy = {
        ...DEFAULT_CONFIG,
        version: 1,
        protectedFiles: DEFAULT_CONFIG.protectedFiles.filter(file => file !== "evidence.json"),
      }
      await fs.writeFile(path.join(tmpDir, ".opencode", "guard.json"), JSON.stringify(legacy), "utf-8")

      const result = await runTool({ subcommand: "status" })

      expect(result.output).toContain("evidence.json")
    })

    it("honors a v2 config that intentionally removed evidence.json", async () => {
      const current = {
        ...DEFAULT_CONFIG,
        version: 2,
        protectedFiles: DEFAULT_CONFIG.protectedFiles.filter(file => file !== "evidence.json"),
      }
      await fs.writeFile(path.join(tmpDir, ".opencode", "guard.json"), JSON.stringify(current), "utf-8")

      const result = await runTool({ subcommand: "status" })

      expect(result.output).not.toContain("evidence.json")
    })
  })

  describe("on subcommand", () => {
    it("enables guard", async () => {
      const result = await runTool({ subcommand: "on" })
      expect(result.title).toBe("Guard Enabled")
      expect(result.output).toContain("enabled")
    })
  })

  describe("off subcommand", () => {
    it("returns confirmation", async () => {
      const result = await runTool({ subcommand: "off" })
      expect(result.title).toBe("Confirm Guard Disable")
      expect(result.metadata?.requiresConfirmation).toBe(true)
    })

    it("disables guard when confirmed", async () => {
      const result = await runTool({ subcommand: "off", confirmed: true })
      expect(result.title).toBe("Guard Disabled")
    })

    it("does not disable guard without confirmed", async () => {
      await runTool({ subcommand: "on" })
      await runTool({ subcommand: "off" })
      const config = JSON.parse(await fs.readFile(path.join(tmpDir, ".opencode", "guard.json"), "utf-8"))
      expect(config.enabled).toBe(true)
    })
  })

  describe("add subcommand", () => {
    it("adds file to protection", async () => {
      const result = await runTool({ subcommand: "add", file: "test.md" })
      expect(result.title).toBe("File Added")
      expect(result.output).toContain("test.md")
    })

    it("returns error without file", async () => {
      const result = await runTool({ subcommand: "add" })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("specify a file")
    })

    it("reports already protected on duplicate add", async () => {
      await runTool({ subcommand: "add", file: "test.md" })
      const result = await runTool({ subcommand: "add", file: "test.md" })
      expect(result.title).toBe("Already Protected")
      expect(result.output).toContain("Nothing changed")
    })
  })

  describe("remove subcommand", () => {
    it("returns confirmation", async () => {
      const result = await runTool({ subcommand: "remove", file: "test.md" })
      expect(result.title).toBe("Confirm Remove Protection")
      expect(result.metadata?.requiresConfirmation).toBe(true)
    })

    it("removes file when confirmed", async () => {
      await runTool({ subcommand: "add", file: "test.md" })
      const result = await runTool({ subcommand: "remove", file: "test.md", confirmed: true })
      expect(result.title).toBe("Protection Removed")
    })

    it("does not remove file without confirmed", async () => {
      await runTool({ subcommand: "add", file: "test.md" })
      await runTool({ subcommand: "remove", file: "test.md" })
      const config = JSON.parse(await fs.readFile(path.join(tmpDir, ".opencode", "guard.json"), "utf-8"))
      expect(config.protectedFiles).toContain("test.md")
    })

    it("returns error without file", async () => {
      const result = await runTool({ subcommand: "remove" })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("specify a file")
    })

    it("reports dynamically protected file instead of false success", async () => {
      const result = await runTool({ subcommand: "remove", file: "spec.md", confirmed: true })
      expect(result.title).toBe("Protected Dynamically")
      expect(result.output).toContain("after approval")
      expect(result.output).toContain("/approve")
      expect(result.output).toContain("Nothing was removed")
    })

    it("reports dynamic protection for full paths by basename", async () => {
      const result = await runTool({ subcommand: "remove", file: path.join(tmpDir, "specs", "001-x", "plan.md"), confirmed: true })
      expect(result.title).toBe("Protected Dynamically")
    })

    it("reports always-protected pattern match without removing", async () => {
      const result = await runTool({ subcommand: "remove", file: "constitution.md", confirmed: true })
      expect(result.title).toBe("Protected By Pattern")
      expect(result.output).toContain("Nothing was removed")
    })

    it("reports not protected file without claiming success", async () => {
      const result = await runTool({ subcommand: "remove", file: "notes.md", confirmed: true })
      expect(result.title).toBe("Not Protected")
      expect(result.output).toContain("Nothing was removed")
    })

    it("keeps config unchanged when removing a dynamic entry", async () => {
      await runTool({ subcommand: "add", file: "test.md" })
      await runTool({ subcommand: "remove", file: "spec.md", confirmed: true })
      const config = JSON.parse(await fs.readFile(path.join(tmpDir, ".opencode", "guard.json"), "utf-8"))
      expect(config.protectedFiles).toContain("test.md")
      expect(config.protectedFiles).not.toContain("spec.md")
    })
  })

  describe("log subcommand", () => {
    it("shows empty log", async () => {
      const result = await runTool({ subcommand: "log" })
      expect(result.title).toBe("Guard Log")
      expect(result.output).toContain("No denials")
    })
  })

  describe("debug subcommand", () => {
    it("shows debug status", async () => {
      const result = await runTool({ subcommand: "debug" })
      expect(result.title).toBe("Debug Status")
      expect(result.output).toContain("OFF")
    })

    it("enables debug", async () => {
      const result = await runTool({ subcommand: "debug", debugOption: "on" })
      expect(result.title).toBe("Debug Enabled")
    })

    it("disables debug", async () => {
      const result = await runTool({ subcommand: "debug", debugOption: "off" })
      expect(result.title).toBe("Debug Disabled")
    })
  })

  describe("error handling", () => {
    it("returns error for invalid worktree", async () => {
      const result = await guardTool.execute({}, { worktree: undefined, sessionID: "test", callID: "test" })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("No worktree path provided")
    })

    it("returns error for invalid project root", async () => {
      const result = await guardTool.execute({}, { worktree: "/nonexistent", sessionID: "test", callID: "test" })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("Not a valid project directory")
    })

    it("returns error for unknown subcommand", async () => {
      const result = await runTool({ subcommand: "unknown" })
      expect(result.title).toBe("Error")
      expect(result.output).toContain("Unknown subcommand")
    })
  })
})
