import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const NEW_SKILLS = ["speckit-explorer", "speckit-converger", "speckit-archiver", "speckit-discovery"]

describe("new skills content", () => {
  for (const skill of NEW_SKILLS) {
    describe(skill, () => {
      let content: string

      beforeAll(async () => {
        content = await fs.readFile(repoPath("skills", skill, "SKILL.md"), "utf-8")
      })

      it("has valid frontmatter with name, description, license", () => {
        expect(content).toMatch(/^---\r?\n/)
        expect(content).toMatch(/name:\s*\S+/)
        expect(content).toMatch(/description:\s*.+/)
        expect(content).toMatch(/license:\s*\S+/)
      })

      it("has compatibility field", () => {
        expect(content).toMatch(/compatibility:\s*opencode/)
      })

      it("has metadata with phase and workflow", () => {
        expect(content).toMatch(/metadata:/)
        expect(content).toMatch(/phase:/)
        expect(content).toMatch(/workflow:\s*sdd/)
      })

      it("has 'What I do' section", () => {
        expect(content).toMatch(/## What I do/)
      })

      it("has 'When to use me' section", () => {
        expect(content).toMatch(/## When to use me/)
      })

      it("has 'How to use me' section", () => {
        expect(content).toMatch(/## How to use me/)
      })

      it("has 'Rules' section", () => {
        expect(content).toMatch(/## Rules/)
      })

      it("has no TODO/FIXME/XXX markers", () => {
        expect(content).not.toMatch(/TODO|FIXME|XXX|HACK/i)
      })
    })
  }
})

describe("new commands content", () => {
  const NEW_COMMANDS = ["explore", "converge", "archive", "discovery"]

  for (const cmd of NEW_COMMANDS) {
    describe(cmd, () => {
      let content: string

      beforeAll(async () => {
        content = await fs.readFile(repoPath("commands", `${cmd}.md`), "utf-8")
      })

      it("has valid frontmatter with description", () => {
        expect(content).toMatch(/^---\r?\n/)
        expect(content).toMatch(/description:\s*.+/)
      })

      it("has Context section", () => {
        expect(content).toMatch(/## Context/)
      })

      it("has Pre-validation section", () => {
        expect(content).toMatch(/## Pre-validation/)
      })

      it("has Task section", () => {
        expect(content).toMatch(/## Task/)
      })

      it("has Rules section", () => {
        expect(content).toMatch(/## Rules/)
      })

      it("has no TODO/FIXME/XXX markers", () => {
        expect(content).not.toMatch(/TODO|FIXME|XXX|HACK/i)
      })

      it("references $ARGUMENTS", () => {
        expect(content).toMatch(/\$ARGUMENTS/)
      })
    })
  }
})

describe("speckit-archive tool content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(repoPath("tools", "speckit-archive.ts"), "utf-8")
  })

  it("exports a default tool", () => {
    expect(content).toMatch(/export default tool\(/)
  })

  it("has description and args", () => {
    expect(content).toMatch(/description:/)
    expect(content).toMatch(/args:/)
  })

  it("has execute function with try/catch", () => {
    expect(content).toMatch(/async execute/)
    expect(content).toMatch(/try \{/)
    expect(content).toMatch(/catch \(/)
  })

  it("uses node: prefixes for imports", () => {
    expect(content).toMatch(/from "node:/)
  })

  it("has no TODO/FIXME/XXX markers", () => {
    expect(content).not.toMatch(/TODO|FIXME|XXX|HACK/i)
  })
})

describe("speckit-events plugin content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(repoPath("tools", "plugins", "speckit-events.ts"), "utf-8")
  })

  it("exports emitEvent and readEvents", () => {
    expect(content).toMatch(/export async function emitEvent/)
    expect(content).toMatch(/export async function readEvents/)
  })

  it("exports detectEvent", () => {
    expect(content).toMatch(/export function detectEvent/)
  })

  it("has SddEvent type", () => {
    expect(content).toMatch(/export interface SddEvent/)
  })

  it("has SddEventType type", () => {
    expect(content).toMatch(/export type SddEventType/)
  })

  it("has default export with id and setup", () => {
    expect(content).toMatch(/id: "speckit-events"/)
    expect(content).toMatch(/async setup/)
  })

  it("has no TODO/FIXME/XXX markers", () => {
    expect(content).not.toMatch(/TODO|FIXME|XXX|HACK/i)
  })
})