import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import scaffoldTool, { resolveTemplatesDir, TEMPLATES_DIR } from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { readSpecJson, specsDirPath, readSession, steeringDirPath, PATHS } from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("Kill surviving mutants — speckit-scaffold", () => {

  describe("slugify edge cases (L39-L42)", () => {
    it("slugifies empty-like input to 'unnamed'", async () => {
      const result = await scaffoldTool.execute({ featureName: "!!!", template: "spec" }, ctx)
      expect(result.metadata?.featureDir).toBe("001-unnamed")
    })

    it("removes leading digits from slug", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "123-test", template: "spec" }, ctx)
      expect(result.metadata?.featureDir).toBe("001-test")
    })

    it("sets truncated flag for long feature names", async () => {
      await createConstitution(worktree)
      const longName = "a".repeat(100)
      const result = await scaffoldTool.execute({ featureName: longName, template: "spec" }, ctx)
      expect(result.metadata?.truncated).toBe(true)
    })

    it("output contains truncation message when name is too long", async () => {
      await createConstitution(worktree)
      const longName = "a".repeat(100)
      const result = await scaffoldTool.execute({ featureName: longName, template: "spec" }, ctx)
      expect(result.output).toContain("truncated")
    })

    it("truncates slug at maxLen boundary", async () => {
      await createConstitution(worktree)
      const longName = "a".repeat(100)
      const result = await scaffoldTool.execute({ featureName: longName, template: "spec" }, ctx)
      const dir = result.metadata?.featureDir ?? ""
      const slug = dir.replace(/^\d+-/, "")
      expect(slug.length).toBeLessThanOrEqual(80)
    })
  })

  describe("output string assertions — constitution (L217, L227)", () => {
    it("constitution exists output contains 'already exists'", async () => {
      await scaffoldTool.execute({ featureName: "P1", template: "constitution" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "P2", template: "constitution" }, ctx)
      expect(result.output).toContain("already exists")
    })

    it("constitution exists output contains 'overwrite'", async () => {
      await scaffoldTool.execute({ featureName: "P1", template: "constitution" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "P2", template: "constitution" }, ctx)
      expect(result.output).toContain("overwrite")
    })

    it("constitution created output contains 'created in .opencode/spec-memory/'", async () => {
      const result = await scaffoldTool.execute({ featureName: "New", template: "constitution" }, ctx)
      expect(result.output).toContain("created in .opencode/spec-memory/")
    })

    it("constitution created output contains 'Next:'", async () => {
      const result = await scaffoldTool.execute({ featureName: "New", template: "constitution" }, ctx)
      expect(result.output).toContain("Next:")
    })
  })

  describe("output string assertions — domain-map/glossary (L241, L251)", () => {
    it("domain-map exists output contains 'already exists'", async () => {
      await scaffoldTool.execute({ featureName: "MyApp", template: "domain-map" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "domain-map" }, ctx)
      expect(result.output).toContain("already exists")
    })

    it("domain-map created output contains 'created in .opencode/'", async () => {
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "domain-map" }, ctx)
      expect(result.output).toContain("created in .opencode/")
    })

    it("glossary exists output contains 'already exists'", async () => {
      await scaffoldTool.execute({ featureName: "MyApp", template: "glossary" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "glossary" }, ctx)
      expect(result.output).toContain("already exists")
    })

    it("glossary created output contains 'created in .opencode/'", async () => {
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "glossary" }, ctx)
      expect(result.output).toContain("created in .opencode/")
    })
  })

  describe("output string assertions — data-model (L263, L282)", () => {
    it("data-model no features error contains 'No matching feature directory'", async () => {
      const result = await scaffoldTool.execute({ featureName: "Test", template: "data-model" }, ctx)
      expect(result.output).toContain("No matching feature directory")
    })

    it("data-model created output contains 'created in specs/'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "data-model" }, ctx)
      expect(result.output).toContain("created in specs/")
    })

    it("data-model created output contains 'Next:'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "data-model" }, ctx)
      expect(result.output).toContain("Next:")
    })

    it("data-model exists output contains 'already exists'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "data-model" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "data-model" }, ctx)
      expect(result.output).toContain("already exists")
    })
  })

  describe("output string assertions — research (L294, L315)", () => {
    it("research no features error contains 'No matching feature directory'", async () => {
      const result = await scaffoldTool.execute({ featureName: "Test", template: "research" }, ctx)
      expect(result.output).toContain("No matching feature directory")
    })

    it("research created output contains 'created in specs/'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "research" }, ctx)
      expect(result.output).toContain("created in specs/")
    })

    it("research exists output contains 'already exists'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "research" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "research" }, ctx)
      expect(result.output).toContain("already exists")
    })
  })

  describe("output string assertions — contracts (L333)", () => {
    it("contracts no features error contains 'No matching feature directory'", async () => {
      const result = await scaffoldTool.execute({ featureName: "Test", template: "contracts" }, ctx)
      expect(result.output).toContain("No matching feature directory")
    })

    it("contracts created output contains 'contracts/ directory created'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)
      expect(result.output).toContain("contracts/ directory created")
    })

    it("contracts created output contains 'Next:'", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)
      expect(result.output).toContain("Next:")
    })
  })

  describe("output string assertions — file exists (L389)", () => {
    it("plan already exists output contains 'already exists in specs/'", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Test", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Test", template: "plan" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Test", template: "plan" }, ctx)
      expect(result.output).toContain("already exists in specs/")
    })

    it("tasks already exists output contains 'already exists in specs/'", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Test", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Test", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Test", template: "tasks" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Test", template: "tasks" }, ctx)
      expect(result.output).toContain("already exists in specs/")
    })

    it("data-model already exists output contains 'already exists in specs/'", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Test", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Test", template: "data-model" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Test", template: "data-model" }, ctx)
      expect(result.output).toContain("already exists in specs/")
    })

    it("research already exists output contains 'already exists in specs/'", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Test", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Test", template: "research" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Test", template: "research" }, ctx)
      expect(result.output).toContain("already exists in specs/")
    })
  })

  describe("output string assertions — scaffold result (L462-L466)", () => {
    it("spec output contains 'created in specs/'", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      expect(result.output).toContain("created in specs/")
    })

    it("spec output contains 'Next: /approve spec'", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      expect(result.output).toContain("Next: /approve spec")
    })

    it("plan output contains 'Next: /approve plan'", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      expect(result.output).toContain("Next: /approve plan")
    })

    it("tasks output contains 'Next: /approve tasks'", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      expect(result.output).toContain("Next: /approve tasks")
    })
  })

  describe("steering output format (L201-L205)", () => {
    it("steering all created output contains 'created:' with comma-separated filenames", async () => {
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "steering" }, ctx)
      expect(result.output).toContain("created: product.md, tech.md, structure.md")
    })

    it("steering all skipped output contains 'skipped (exist):' with comma-separated filenames", async () => {
      await scaffoldTool.execute({ featureName: "MyApp", template: "steering" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "steering" }, ctx)
      expect(result.output).toContain("skipped (exist): product.md, tech.md, structure.md")
    })

    it("steering output uses ' | ' separator between created and skipped", async () => {
      const steeringDir = steeringDirPath(worktree)
      await fs.mkdir(steeringDir, { recursive: true })
      await fs.writeFile(path.join(steeringDir, "product.md"), "existing", "utf-8")
      const result = await scaffoldTool.execute({ featureName: "V1", template: "steering" }, ctx)
      expect(result.output).toContain(" | ")
      expect(result.output).toContain("created:")
      expect(result.output).toContain("skipped (exist):")
    })

    it("steering output contains 'Next:'", async () => {
      const result = await scaffoldTool.execute({ featureName: "MyApp", template: "steering" }, ctx)
      expect(result.output).toContain("Next:")
    })
  })

  describe("padStart with '0' (L401)", () => {
    it("feature number is zero-padded to 3 digits", async () => {
      await createConstitution(worktree)
      const result = await scaffoldTool.execute({ featureName: "Test", template: "spec" }, ctx)
      expect(result.metadata?.featureDir).toMatch(/^001-/)
      const num = result.metadata?.featureDir?.split("-")[0]
      expect(num).toBe("001")
      expect(num?.length).toBe(3)
    })
  })

  describe("history truncation (L458)", () => {
    it("truncates session history to 20 entries", async () => {
      await createConstitution(worktree)
      for (let i = 0; i < 22; i++) {
        await scaffoldTool.execute({ featureName: `Feature${i}`, template: "spec" }, ctx)
      }
      const session = await readSession(worktree)
      expect(session.history.length).toBeLessThanOrEqual(20)
    })

    it("keeps the last 20 entries when truncating", async () => {
      await createConstitution(worktree)
      for (let i = 0; i < 22; i++) {
        await scaffoldTool.execute({ featureName: `Feature${i}`, template: "spec" }, ctx)
      }
      const session = await readSession(worktree)
      expect(session.history[0]).toBe("/spec")
      expect(session.history.length).toBe(20)
    })
  })

  describe("contracts overwrite condition (L326)", () => {
    it("skips contracts template when exists and no overwrite", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)
      const contractsDir = path.join(worktree, "specs", "001-auth", "contracts")
      const templatePath = path.join(contractsDir, "_template.md")
      const contentBefore = await fs.readFile(templatePath, "utf-8")
      await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)
      const contentAfter = await fs.readFile(templatePath, "utf-8")
      expect(contentAfter).toBe(contentBefore)
    })

    it("overwrites contracts template when overwrite=true", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)
      const result = await scaffoldTool.execute({ featureName: "Auth", template: "contracts", overwrite: true }, ctx)
      expect(result.output).toContain("contracts/ directory created")
    })

    it("fills _template.md with the real template from the kit, not with a silent empty file", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "contracts" }, ctx)

      const generated = await fs.readFile(path.join(worktree, "specs", "001-auth", "contracts", "_template.md"), "utf-8")
      const shipped = await fs.readFile(path.join(TEMPLATES_DIR, "contracts-template.md"), "utf-8")

      expect(generated.length).toBeGreaterThan(0)
      expect(generated).not.toContain("[FEATURE NAME]")
      expect(generated).not.toContain("NNN-feature-name")
      expect(generated).toBe(shipped.replace(/\[FEATURE NAME\]/g, "Auth").replace(/NNN-feature-name/g, "001-auth"))
    })
  })

  describe("templates directory resolution", () => {
    it("takes the first candidate that exists", () => {
      expect(resolveTemplatesDir([path.join(worktree, "absent"), TEMPLATES_DIR])).toBe(TEMPLATES_DIR)
    })

    it("returns the first candidate when none exists, so the caller can report it", () => {
      const absent = path.join(worktree, "no-templates-here")
      expect(resolveTemplatesDir([absent, path.join(worktree, "also-absent")])).toBe(absent)
    })

    it("resolves a real templates directory even when the tool runs from a sandbox", () => {
      expect(existsSync(path.join(TEMPLATES_DIR, "contracts-template.md"))).toBe(true)
    })
  })

  describe("session.lastResult (L456)", () => {
    it("session lastResult contains created in specs/", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.lastResult).toContain("created in specs/")
    })

    it("session lastResult contains the feature dir name", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.lastResult).toContain("001-auth")
    })
  })

  describe("session command and phase (L450-L451)", () => {
    it("session command is set to /spec after spec scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.command).toBe("/spec")
    })

    it("session phase is set to 'spec' after spec scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.phase).toBe("spec")
    })

    it("session command is set to /plan after plan scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      const session = await readSession(worktree)
      expect(session.command).toBe("/plan")
    })

    it("session phase is set to 'plan' after plan scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      const session = await readSession(worktree)
      expect(session.phase).toBe("plan")
    })

    it("session command is set to /tasks after tasks scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const session = await readSession(worktree)
      expect(session.command).toBe("/tasks")
    })

    it("session phase is set to 'tasks' after tasks scaffold", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const session = await readSession(worktree)
      expect(session.phase).toBe("tasks")
    })
  })

  describe("session featureName and nextStep (L454-L455)", () => {
    it("session featureName matches input", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "My Feature", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.featureName).toBe("My Feature")
    })

    it("session nextStep is /approve spec after spec", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const session = await readSession(worktree)
      expect(session.nextStep).toBe("/approve spec")
    })

    it("session nextStep is /approve plan after plan", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      const session = await readSession(worktree)
      expect(session.nextStep).toBe("/approve plan")
    })

    it("session nextStep is /approve tasks after tasks", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const session = await readSession(worktree)
      expect(session.nextStep).toBe("/approve tasks")
    })
  })

  describe("MARKER_TEMPLATES content branching (L128)", () => {
    it("spec uses marker template content", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      const content = await fs.readFile(path.join(worktree, "specs", "001-auth", "spec.md"), "utf-8")
      expect(content).toContain("Content pending skill generation")
      expect(content).toContain("# spec: Auth")
    })

    it("plan uses marker template content", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      const content = await fs.readFile(path.join(worktree, "specs", "001-auth", "plan.md"), "utf-8")
      expect(content).toContain("Content pending skill generation")
      expect(content).toContain("# plan: Auth")
    })

    it("tasks uses marker template content", async () => {
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "tasks" }, ctx)
      const content = await fs.readFile(path.join(worktree, "specs", "001-auth", "tasks.md"), "utf-8")
      expect(content).toContain("Content pending skill generation")
      expect(content).toContain("# tasks: Auth")
    })

    it("data-model does NOT use marker template content", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "data-model" }, ctx)
      const content = await fs.readFile(path.join(worktree, "specs", "001-auth", "data-model.md"), "utf-8")
      expect(content).not.toContain("Content pending skill generation")
      expect(content).toContain("Data Model")
    })

    it("research does NOT use marker template content", async () => {
      await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
      await scaffoldTool.execute({ featureName: "Auth", template: "research" }, ctx)
      const content = await fs.readFile(path.join(worktree, "specs", "001-auth", "research.md"), "utf-8")
      expect(content).not.toContain("Content pending skill generation")
      expect(content).toContain("Research")
    })
  })

  describe("clearCorruptionWarnings (L150)", () => {
    it("corruption warnings are cleared after scaffold runs", async () => {
      const types = await import("../../shared/types")
      types.pushCorruptionWarning("test source", "test warning")
      expect(types.corruptionWarnings.length).toBeGreaterThan(0)
      await createConstitution(worktree)
      await scaffoldTool.execute({ featureName: "Test", template: "constitution" }, ctx)
      expect(types.corruptionWarnings.length).toBe(0)
    })
  })

  describe("error output messages (L480-L484)", () => {
    it("error output contains error message for no worktree", async () => {
      const result = await scaffoldTool.execute({ featureName: "Test", template: "spec" }, { worktree: undefined } as any)
      expect(result.output).toContain("No worktree path provided")
    })

    it("error title is 'Error' for no worktree", async () => {
      const result = await scaffoldTool.execute({ featureName: "Test", template: "spec" }, { worktree: undefined } as any)
      expect(result.title).toBe("Error")
    })
  })
})
