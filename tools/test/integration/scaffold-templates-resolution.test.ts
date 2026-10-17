import { describe, it, expect, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"

const ORIGINAL_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

// A home directory carrying its own templates is the condition that hid the bug, because the old fallback found something to read.
async function createHomeWithTemplates(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-fake-home-"))
  const templates = path.join(home, ".config", "opencode", "templates")
  await fs.mkdir(templates, { recursive: true })
  for (const name of ["spec-template.md", "contracts-template.md", "plan-template.md"]) {
    await fs.writeFile(path.join(templates, name), "# written by the home copy\n", "utf-8")
  }
  return home
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe("templates directory contract", () => {
  let home: string
  let worktree: string

  afterEach(async () => {
    restoreEnv()
    vi.resetModules()
    if (worktree) await destroyTempWorktree(worktree)
    if (home) await fs.rm(home, { recursive: true, force: true })
  })

  it("keeps searching past a directory named templates that holds no real templates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-decoy-"))
    try {
      // An empty folder called templates is exactly what the old existence check accepted, so the search must skip it.
      await fs.mkdir(path.join(root, "templates"), { recursive: true })
      const real = path.join(root, "nested")
      await fs.mkdir(path.join(real, "templates"), { recursive: true })
      await fs.writeFile(path.join(real, "templates", "spec-template.md"), "# Spec\n", "utf-8")

      const { findTemplatesDir } = await import("../../speckit-scaffold")
      expect(findTemplatesDir(path.join(real, "tools"))).toBe(path.join(real, "templates"))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("returns null instead of a directory that cannot serve the templates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-nothing-"))
    try {
      const { findTemplatesDir } = await import("../../speckit-scaffold")
      // A null result is what forces the home copy to stay a real last resort rather than a silent substitution.
      expect(findTemplatesDir(path.join(root, "a", "b", "c"))).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("prefers the checkout templates over a populated home copy", async () => {
    home = await createHomeWithTemplates()
    process.env.HOME = home
    process.env.USERPROFILE = home
    vi.resetModules()

    const scaffold = await import("../../speckit-scaffold")

    expect(scaffold.TEMPLATES_DIR.startsWith(home), "the home copy won the resolution").toBe(false)
    expect(existsSync(path.join(scaffold.TEMPLATES_DIR, "contracts-template.md"))).toBe(true)
  })

  it("scaffolds contracts from the checkout template and not from the home one", async () => {
    home = await createHomeWithTemplates()
    process.env.HOME = home
    process.env.USERPROFILE = home
    vi.resetModules()

    const scaffold = await import("../../speckit-scaffold")
    worktree = await createTempWorktree()
    const ctx = mockContext(worktree)

    await scaffold.default.execute({ featureName: "Auth", template: "spec" }, ctx)
    await scaffold.default.execute({ featureName: "Auth", template: "contracts" }, ctx)

    const generated = await fs.readFile(
      path.join(worktree, "specs", "001-auth", "contracts", "_template.md"),
      "utf-8",
    )
    expect(generated).not.toContain("written by the home copy")
    expect(generated.length).toBeGreaterThan(0)
  })

  it("still finds the templates when the home directory has none at all", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-empty-home-"))
    process.env.HOME = home
    process.env.USERPROFILE = home
    vi.resetModules()

    const scaffold = await import("../../speckit-scaffold")

    expect(scaffold.TEMPLATES_DIR.startsWith(home)).toBe(false)
    expect(existsSync(path.join(scaffold.TEMPLATES_DIR, "contracts-template.md"))).toBe(true)
  })
})
