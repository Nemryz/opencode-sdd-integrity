import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const SKILL_PATH = repoPath("skills", "speckit-plan-engineer", "SKILL.md")

describe("speckit-plan-engineer SKILL.md content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(SKILL_PATH, "utf-8")
  })

  it("has a conversational proposal section before generating plan", () => {
    const proposalMatch = content.match(/proposal/i)
    const generateIndex = content.indexOf("Step 4: Generate Plan")
    expect(proposalMatch).not.toBeNull()
    expect(proposalMatch!.index).toBeLessThan(generateIndex)
  })

  it("has a proposal template with Tech Stack, Key Decisions, Boundary Map, Risks", () => {
    expect(content).toMatch(/Tech Stack/)
    expect(content).toMatch(/Key Decisions/)
    expect(content).toMatch(/Boundary Map/)
    expect(content).toMatch(/Risks/)
    expect(content).toMatch(/Confirmation/)
  })

  it("express mode guard appears before generate plan step", () => {
    const emIndex = content.indexOf("Express Mode")
    const generateIndex = content.indexOf("Step 4: Generate Plan")
    expect(emIndex).not.toBe(-1)
    expect(emIndex).toBeLessThan(generateIndex)
  })

  it("express mode references config.json expressMode field", () => {
    expect(content).toMatch(/expressMode.*true|expressMode|config\.json.*express/i)
  })

  it("express mode describes skip and proceed behavior", () => {
    expect(content).toMatch(/skip this step and proceed directly/i)
  })

  it("waits for user confirmation before proceeding", () => {
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

  it("loads constitution.md in context step", () => {
    expect(content).toMatch(/constitution\.md/)
  })

  it("loads domain-map.md in context step", () => {
    expect(content).toMatch(/domain-map\.md/)
  })

  it("loads steering context in context step", () => {
    expect(content).toMatch(/steering/i)
  })

  it("loads shared rules in context step", () => {
    expect(content).toMatch(/skills\/rules\/design-principles\.md/)
  })

  it("uses concrete _Boundary: ComponentName_ annotation format", () => {
    expect(content).toMatch(/_Boundary:/)
  })

  it("uses _Boundary: in Boundary Map in proposal", () => {
    const proposalIdx = content.indexOf("Conversational Proposal")
    const boundaryBlock = content.slice(proposalIdx, content.indexOf("### Risks", proposalIdx))
    expect(boundaryBlock).toMatch(/_Boundary:/)
  })

  it("uses _Boundary: in component descriptions in generation step", () => {
    expect(content).toMatch(/Boundary.*Component|component.*Boundary/i)
  })

  it("uses @mention syntax for sub-agents", () => {
    expect(content).toMatch(/@[\w-]+/)
  })

  it("references @explore as a sub-agent", () => {
    expect(content).toMatch(/@explore/)
  })

  it("describes sub-agent research for complex decisions", () => {
    const hasResearch = /sub-agent.*research|research.*sub-agent|Sub-Agent Research/i.test(content)
    expect(hasResearch).toBe(true)
  })

  it("has a quality checklist section", () => {
    expect(content).toMatch(/- \[ \]/)
  })

  it("quality checklist includes boundary, @mention, proposal, gates items", () => {
    expect(content).toMatch(/Boundary/)
    expect(content).toMatch(/@mention/)
    expect(content).toMatch(/proposal/i)
    expect(content).toMatch(/Constitution gates|Simplicity Gate/i)
  })

  it("has a dedicated Reference section", () => {
    expect(content).toMatch(/## Reference/)
  })

  it("Reference section includes shared rules, sub-agents, boundary annotation format", () => {
    const refStart = content.indexOf("## Reference")
    const refBlock = content.slice(refStart)
    expect(refBlock).toMatch(/skills\/rules\//)
    expect(refBlock).toMatch(/@explore/)
    expect(refBlock).toMatch(/_Boundary:/)
  })

  it("has error handling sections", () => {
    expect(content).toMatch(/Error:/)
  })

  it("has Constitution Gates section", () => {
    expect(content).toMatch(/Constitution gates/i)
    expect(content).toMatch(/Simplicity Gate/)
    expect(content).toMatch(/Anti-Abstraction Gate/)
    expect(content).toMatch(/Integration-First/i)
  })

  it("has an Output location section", () => {
    expect(content).toMatch(/Output location/)
  })

  it("generates optional artifacts like research.md, data-model.md, contracts", () => {
    expect(content).toMatch(/research\.md/)
    expect(content).toMatch(/data-model\.md/)
    expect(content).toMatch(/contracts/)
  })
})
