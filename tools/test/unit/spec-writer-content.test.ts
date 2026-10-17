import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const SKILL_PATH = repoPath("skills", "speckit-spec-writer", "SKILL.md")

describe("speckit-spec-writer SKILL.md content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(SKILL_PATH, "utf-8")
  })

  it("has a conversational proposal section before generating spec", () => {
    const proposalMatch = content.match(/proposal/i)
    const generateIndex = content.indexOf("Step 3: Generate Spec")
    expect(proposalMatch).not.toBeNull()
    expect(proposalMatch!.index).toBeLessThan(generateIndex)
  })

  it("has a proposal template with Stories and Boundaries", () => {
    expect(content).toMatch(/Stories/)
    expect(content).toMatch(/Boundaries/)
    expect(content).toMatch(/Confirmation/)
  })

  it("express mode guard appears before generate step", () => {
    const emIndex = content.indexOf("Express Mode")
    const generateIndex = content.indexOf("Step 3: Generate Spec")
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
    expect(content).toMatch(/skills\/rules\/spec-writing\.md/)
  })

  it("documents Owns and Does NOT own boundaries in proposal", () => {
    expect(content).toMatch(/Owns/)
    expect(content).toMatch(/Does NOT own/)
  })

  it("uses @mention syntax for sub-agents", () => {
    expect(content).toMatch(/@[\w-]+/)
  })

  it("references @explore as a sub-agent", () => {
    expect(content).toMatch(/@explore/)
  })

  it("describes sub-agent dispatch for ambiguous features", () => {
    const hasDispatch = /sub-agent.*dispatch|dispatch.*sub-agent|dispatch sub-/i.test(content)
    const hasSubAgents = content.includes("Sub-agent dispatch")
    expect(hasDispatch || hasSubAgents).toBe(true)
  })

  it("has a quality checklist section", () => {
    expect(content).toMatch(/- \[ \]/)
  })

  it("quality checklist includes proposal, boundaries, @mention, steering items", () => {
    expect(content).toMatch(/proposal/i)
    expect(content).toMatch(/Boundar/)
    expect(content).toMatch(/@mention/)
    expect(content).toMatch(/steering/i)
  })

  it("has a dedicated Reference section", () => {
    expect(content).toMatch(/## Reference/)
  })

  it("Reference section includes shared rules, sub-agents, domain map", () => {
    const refStart = content.indexOf("## Reference")
    const refBlock = content.slice(refStart)
    expect(refBlock).toMatch(/skills\/rules\//)
    expect(refBlock).toMatch(/@explore/)
    expect(refBlock).toMatch(/domain-map\.md/)
  })

  it("has error handling sections", () => {
    expect(content).toMatch(/Error:/)
  })

  it("handles ambiguous feature boundaries", () => {
    expect(content).toMatch(/ambiguous.*boundar|boundar.*ambiguous/i)
  })

  it("marks ambiguous areas with NEEDS CLARIFICATION", () => {
    expect(content).toMatch(/NEEDS CLARIFICATION/)
  })

  it("has an Output location section", () => {
    expect(content).toMatch(/Output location/)
  })

  it("mentions Gherkin scenarios in generation", () => {
    expect(content).toMatch(/Gherkin|Given\/When\/Then/i)
  })
})
