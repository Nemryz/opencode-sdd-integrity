import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { isKitOwned, repoPath } from "../helpers/setup"

const AGENTS_PATH = repoPath("AGENTS.md")
const COMMANDS_DIR = path.resolve(AGENTS_PATH, "..", "commands")
const TOOLS_DIR = path.resolve(AGENTS_PATH, "..", "tools")
const SKILLS_DIR = path.resolve(AGENTS_PATH, "..", "skills")

describe("AGENTS.md completeness", () => {
  let content: string
  let commandFiles: string[]
  let toolFiles: string[]
  let skillDirs: string[]

  beforeAll(async () => {
    content = await fs.readFile(AGENTS_PATH, "utf-8")
    commandFiles = (await fs.readdir(COMMANDS_DIR))
      .filter(f => f.endsWith(".md") && isKitOwned(`commands/${f}`))
      .map(f => f.replace(".md", ""))
    toolFiles = (await fs.readdir(TOOLS_DIR))
      .filter(f => f.startsWith("speckit-") && f.endsWith(".ts") && isKitOwned(`tools/${f}`))
      .map(f => f.replace(".ts", ""))
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true })
    skillDirs = entries.filter(e => e.isDirectory() && isKitOwned(`skills/${e.name}`)).map(e => e.name)
  })

  it("documents all commands in the Commands section", () => {
    const commandsSection = content.slice(content.indexOf("## Commands"), content.indexOf("---", content.indexOf("## Commands")))
    for (const cmd of commandFiles) {
      if (cmd === "review") continue // /review is exempt (discussed separately)
      expect(commandsSection).toMatch(new RegExp("/" + cmd, "i"))
    }
  })

  it("documents all tools in the Available Tools table", () => {
    const toolsSection = content.slice(content.indexOf("## Available Tools"), content.indexOf("## Constitution Template"))
    for (const tool of toolFiles) {
      expect(toolsSection).toMatch(new RegExp("`" + tool + "`"))
    }
  })

  it("documents all skills in the Available Skills table", () => {
    const skillsSection = content.slice(content.indexOf("## Available Skills"), content.indexOf("## Available Tools"))
    const skillDirsClean = skillDirs.filter(d => d !== "rules")
    for (const skill of skillDirsClean) {
      expect(skillsSection).toMatch(new RegExp("`" + skill + "`"))
    }
  })

  it("mentions all tools in the Custom Tool Error Handling section", () => {
    const customSection = content.slice(content.indexOf("## Custom Tool Error Handling"), content.indexOf("### If a tool crashes opencode"))
    for (const tool of toolFiles) {
      expect(customSection).toMatch(new RegExp("`" + tool + "`"))
    }
  })

  it("has a Commands section with /audit documented", () => {
    expect(content).toMatch(/\/audit/)
  })

  it("includes speckit-complexity in Available Tools", () => {
    expect(content).toMatch(/speckit-complexity/)
  })

  it("includes speckit-audit in Available Tools", () => {
    expect(content).toMatch(/speckit-audit/)
  })

  it("Known Regression History is documented in docs/regressions.md with real commit hashes", async () => {
    const regPath = path.resolve(AGENTS_PATH, "..", "docs", "regressions.md")
    const regContent = await fs.readFile(regPath, "utf-8")
    const commitMatches = regContent.matchAll(/\b([a-f0-9]{7,})\b/g)
    const hashes = [...commitMatches].map(m => m[1])
    expect(hashes.length).toBeGreaterThanOrEqual(3)
    expect(content).toContain("docs/regressions.md")
  })

  it("High risk C-category range matches actual high-risk.test.ts", async () => {
    const hrPath = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "test",
      "integration",
      "high-risk.test.ts",
    )
    const hrContent = await fs.readFile(hrPath, "utf-8")
    const categoryDescribes = hrContent.match(/describe\("C-\d+/g) || []
    const maxC = Math.max(
      ...categoryDescribes.map(c => parseInt(c.replace("describe(\"C-", ""), 10)),
    )
    const match = content.match(/C-1 through C-(\d+)/)
    expect(match).not.toBeNull()
    expect(parseInt(match![1], 10)).toBe(maxC)
  })

  it("each Test Patterns subsection has a heading", async () => {
    const patternSection = content.slice(
      content.indexOf("## Test Patterns"),
      content.indexOf("---", content.indexOf("## Test Patterns")),
    )
    const subsections = patternSection.match(/### .+/g)
    expect(subsections).not.toBeNull()
  })
})
