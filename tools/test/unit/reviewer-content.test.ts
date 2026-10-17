import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const SKILL_PATH = repoPath("skills", "speckit-reviewer", "SKILL.md")

describe("speckit-reviewer SKILL.md content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(SKILL_PATH, "utf-8")
  })

  it("has a conversational proposal section before dispatch", () => {
    const proposalMatch = content.match(/proposal/i)
    const dispatchIndex = content.indexOf("Sub-Agent Dispatch")
    expect(proposalMatch).not.toBeNull()
    expect(proposalMatch!.index).toBeLessThan(dispatchIndex)
  })

  it("has a proposal template with Scope and Dispatch Plan", () => {
    expect(content).toMatch(/Scope/)
    expect(content).toMatch(/Dispatch Plan/)
    expect(content).toMatch(/Confirmation/)
  })

  it("waits for user confirmation before proceeding to dispatch", () => {
    expect(content).toMatch(/wait.*user confirmation|confirmation.*proceed/i)
  })

  it("has shared-rules in frontmatter metadata", () => {
    expect(content).toMatch(/shared-rules:/)
  })

  it("references shared rules from skills/rules/", () => {
    const rulesRef = content.match(/skills\/rules\/[\w-]+\.md/g)
    expect(rulesRef).not.toBeNull()
    expect(rulesRef!.length).toBeGreaterThanOrEqual(1)
  })

  it("references all three shared rule files", () => {
    expect(content).toMatch(/spec-writing\.md/)
    expect(content).toMatch(/design-principles\.md/)
    expect(content).toMatch(/tasks-generation\.md/)
  })

  it("loads domain-map.md in context step", () => {
    expect(content).toMatch(/domain-map\.md/)
  })

  it("loads steering context in context step", () => {
    expect(content).toMatch(/steering/i)
  })

  it("uses @mention syntax for sub-agents", () => {
    expect(content).toMatch(/@[\w-]+/)
  })

  it("references @speckit-reviewer and @explore as sub-agents", () => {
    expect(content).toMatch(/@speckit-reviewer/)
    expect(content).toMatch(/@explore/)
  })

  it("mentions parallel sub-agent dispatch for artifact review", () => {
    const hasParallel = /parallel|sub-agent|dispatch/i.test(content)
    const hasPerArtifact = /per artifact|each artifact|review.*parallel/i.test(content)
    expect(hasParallel || hasPerArtifact).toBe(true)
  })

  it("has a quality checklist section in review dimensions", () => {
    expect(content).toMatch(/- \[ \]/)
  })

  it("has boundary audit review dimension", () => {
    expect(content).toMatch(/Boundary audit/i)
  })

  it("has ownership classification section", () => {
    expect(content).toMatch(/LOCAL/)
    expect(content).toMatch(/UPSTREAM/)
    expect(content).toMatch(/UNCLEAR/)
  })

  it("has kiro-verify-completion protocol", () => {
    expect(content).toMatch(/kiro-verify/i)
    expect(content).toMatch(/GO/)
    expect(content).toMatch(/NO-GO|MANUAL_VERIFY/)
  })

  it("has a dedicated Reference section", () => {
    expect(content).toMatch(/## Reference/)
  })

  it("Reference section includes shared rules, sub-agents, constitution", () => {
    const refStart = content.indexOf("## Reference")
    const refBlock = content.slice(refStart)
    expect(refBlock).toMatch(/skills\/rules\//)
    expect(refBlock).toMatch(/@explore/)
    expect(refBlock).toMatch(/@speckit-reviewer/)
    expect(refBlock).toMatch(/constitution\.md/)
  })

  it("has error handling sections", () => {
    expect(content).toMatch(/Error:/)
  })

  it("handles sub-agent dispatch failure with fallback", () => {
    expect(content).toMatch(/sub-agent.*fail/i)
  })

  it("has an Output location section", () => {
    expect(content).toMatch(/Output location/)
  })

  it("mentions a report format section", () => {
    expect(content).toMatch(/Report format/i)
  })
})
