import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  isProtectedFile,
  isProtectedAfterApproval,
  isApprovedForFile,
  isProtectedByPhase,
  addDenial,
  DEFAULT_CONFIG,
  GUARD_CONFIG_VERSION,
  migrateGuardConfig,
  type GuardConfig,
} from "../../plugins/speckit-guard"

describe("speckit-guard unit", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-unit-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe("isProtectedFile", () => {
    it("returns reason for constitution.md", () => {
      const result = isProtectedFile(".opencode/spec-memory/constitution.md", DEFAULT_CONFIG)
      expect(result).toContain("Always protected")
    })

    it("returns reason for session.json", () => {
      const result = isProtectedFile(".opencode/spec-memory/session.json", DEFAULT_CONFIG)
      expect(result).toContain("Always protected")
    })

    it("returns reason for config.json", () => {
      const result = isProtectedFile(".opencode/spec-memory/config.json", DEFAULT_CONFIG)
      expect(result).toContain("Always protected")
    })

    it("does not protect steering files, they are written by /steering", () => {
      expect(isProtectedFile(".opencode/steering/product.md", DEFAULT_CONFIG)).toBeNull()
      expect(isProtectedFile(".opencode/steering/tech.md", DEFAULT_CONFIG)).toBeNull()
      expect(isProtectedFile(".opencode/steering/structure.md", DEFAULT_CONFIG)).toBeNull()
    })

    it("returns null for unprotected files", () => {
      const result = isProtectedFile("specs/001-test/spec.md", DEFAULT_CONFIG)
      expect(result).toBeNull()
    })

    it("returns null for plan.md when not protected", () => {
      const config: GuardConfig = { ...DEFAULT_CONFIG, protectedFiles: [] }
      const result = isProtectedFile("specs/001-test/plan.md", config)
      expect(result).toBeNull()
    })
  })

  describe("isProtectedAfterApproval", () => {
    it("returns reason for spec.json", () => {
      const result = isProtectedAfterApproval("specs/001-test/spec.json", DEFAULT_CONFIG)
      expect(result).toContain("Protected after approval")
    })

    it("returns reason for spec.md", () => {
      const result = isProtectedAfterApproval("specs/001-test/spec.md", DEFAULT_CONFIG)
      expect(result).toContain("Protected after approval")
    })

    it("returns reason for plan.md", () => {
      const result = isProtectedAfterApproval("specs/001-test/plan.md", DEFAULT_CONFIG)
      expect(result).toContain("Protected after approval")
    })

    it("returns reason for tasks.md", () => {
      const result = isProtectedAfterApproval("specs/001-test/tasks.md", DEFAULT_CONFIG)
      expect(result).toContain("Protected after approval")
    })

    it("returns null for unprotected files", () => {
      const result = isProtectedAfterApproval("specs/001-test/research.md", DEFAULT_CONFIG)
      expect(result).toBeNull()
    })
  })

  describe("isApprovedForFile", () => {
    it("returns true for spec.json when approved", () => {
      const spec = {
        phase: "ready",
        approvals: {
          spec: { generated: true, approved: true },
          plan: { generated: true, approved: true },
          tasks: { generated: true, approved: true },
        },
      }
      expect(isApprovedForFile("spec.json", spec)).toBe(true)
    })

    it("returns true for spec.md when approved", () => {
      const spec = {
        phase: "ready",
        approvals: {
          spec: { generated: true, approved: true },
          plan: { generated: true, approved: true },
          tasks: { generated: true, approved: true },
        },
      }
      expect(isApprovedForFile("spec.md", spec)).toBe(true)
    })

    it("returns true for plan.md when approved", () => {
      const spec = {
        phase: "ready",
        approvals: {
          spec: { generated: true, approved: true },
          plan: { generated: true, approved: true },
          tasks: { generated: true, approved: true },
        },
      }
      expect(isApprovedForFile("plan.md", spec)).toBe(true)
    })

    it("returns true for tasks.md when approved", () => {
      const spec = {
        phase: "ready",
        approvals: {
          spec: { generated: true, approved: true },
          plan: { generated: true, approved: true },
          tasks: { generated: true, approved: true },
        },
      }
      expect(isApprovedForFile("tasks.md", spec)).toBe(true)
    })

    it("returns false when not approved", () => {
      const spec = {
        phase: "spec",
        approvals: {
          spec: { generated: true, approved: false },
          plan: { generated: false, approved: false },
          tasks: { generated: false, approved: false },
        },
      }
      expect(isApprovedForFile("spec.json", spec)).toBe(false)
    })

    it("returns false for unknown files", () => {
      const spec = {
        phase: "ready",
        approvals: {
          spec: { generated: true, approved: true },
          plan: { generated: true, approved: true },
          tasks: { generated: true, approved: true },
        },
      }
      expect(isApprovedForFile("research.md", spec)).toBe(false)
    })
  })

  describe("isProtectedByPhase", () => {
    it("returns reason for plan.md in tasks phase", () => {
      const result = isProtectedByPhase("specs/001-test/plan.md", "tasks", DEFAULT_CONFIG)
      expect(result).toContain("Protected in tasks phase")
    })

    it("returns reason for plan.md in ready phase", () => {
      const result = isProtectedByPhase("specs/001-test/plan.md", "ready", DEFAULT_CONFIG)
      expect(result).toContain("Protected in ready phase")
    })

    it("returns reason for tasks.md in ready phase", () => {
      const result = isProtectedByPhase("specs/001-test/tasks.md", "ready", DEFAULT_CONFIG)
      expect(result).toContain("Protected in ready phase")
    })

    it("returns reason for spec.md in complete phase", () => {
      const result = isProtectedByPhase("specs/001-test/spec.md", "complete", DEFAULT_CONFIG)
      expect(result).toContain("Protected in complete phase")
    })

    it("returns null for unprotected files in phase", () => {
      const result = isProtectedByPhase("specs/001-test/spec.md", "tasks", DEFAULT_CONFIG)
      expect(result).toBeNull()
    })

    it("returns null for unknown phases", () => {
      const result = isProtectedByPhase("specs/001-test/plan.md", "unknown", DEFAULT_CONFIG)
      expect(result).toBeNull()
    })
  })

  describe("addDenial", () => {
    it("adds denial to config", () => {
      const config: GuardConfig = { ...DEFAULT_CONFIG, denials: [] }
      addDenial(config, "test.md", "Always protected")
      expect(config.denials.length).toBe(1)
      expect(config.denials[0].file).toBe("test.md")
      expect(config.denials[0].reason).toBe("Always protected")
    })

    it("adds denial at beginning", () => {
      const config: GuardConfig = { ...DEFAULT_CONFIG, denials: [] }
      addDenial(config, "first.md", "reason1")
      addDenial(config, "second.md", "reason2")
      expect(config.denials[0].file).toBe("second.md")
      expect(config.denials[1].file).toBe("first.md")
    })

    it("limits denials to 10", () => {
      const config: GuardConfig = { ...DEFAULT_CONFIG, denials: [] }
      for (let i = 0; i < 15; i++) {
        addDenial(config, `file${i}.md`, `reason${i}`)
      }
      expect(config.denials.length).toBe(10)
      expect(config.denials[0].file).toBe("file14.md")
    })

    it("includes timestamp", () => {
      const config: GuardConfig = { ...DEFAULT_CONFIG, denials: [] }
      addDenial(config, "test.md", "reason")
      expect(config.denials[0].timestamp).toBeDefined()
    })
  })

  describe("migrateGuardConfig", () => {
    it("adds evidence protection to a v1 config and bumps the version", () => {
      const legacy: GuardConfig = {
        ...DEFAULT_CONFIG,
        version: 1,
        protectedFiles: DEFAULT_CONFIG.protectedFiles.filter(file => file !== "evidence.json"),
      }

      const migrated = migrateGuardConfig(legacy)

      expect(migrated.version).toBe(GUARD_CONFIG_VERSION)
      expect(migrated.protectedFiles).toContain("evidence.json")
      expect(legacy.protectedFiles).not.toContain("evidence.json")
    })

    it("does not duplicate evidence.json when the v1 config already lists it", () => {
      const legacy: GuardConfig = { ...DEFAULT_CONFIG, version: 1 }
      const migrated = migrateGuardConfig(legacy)

      expect(migrated.protectedFiles.filter(file => file === "evidence.json")).toHaveLength(1)
    })

    it("honors a v2 config that removed evidence protection", () => {
      const current: GuardConfig = {
        ...DEFAULT_CONFIG,
        protectedFiles: DEFAULT_CONFIG.protectedFiles.filter(file => file !== "evidence.json"),
      }

      const migrated = migrateGuardConfig(current)

      expect(migrated.version).toBe(GUARD_CONFIG_VERSION)
      expect(migrated.protectedFiles).not.toContain("evidence.json")
    })
  })
})
