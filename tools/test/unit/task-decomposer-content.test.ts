import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const SKILL_PATH = repoPath("skills", "speckit-task-decomposer", "SKILL.md")

describe("speckit-task-decomposer SKILL.md content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(SKILL_PATH, "utf-8")
  })

  it("has a conversational proposal section before generating tasks", () => {
    const proposalMatch = content.match(/proposal/i)
    const generateIndex = content.indexOf("Step 3: Generate Tasks")
    expect(proposalMatch).not.toBeNull()
    expect(proposalMatch!.index).toBeLessThan(generateIndex)
  })

  it("has a proposal template with Phases and Boundary Map", () => {
    expect(content).toMatch(/Phases/)
    expect(content).toMatch(/Boundary Map/)
    expect(content).toMatch(/Confirmation/)
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

  it("loads domain-map.md in context step", () => {
    expect(content).toMatch(/domain-map\.md/)
  })

  it("loads steering context in context step", () => {
    expect(content).toMatch(/steering/i)
  })

  it("loads shared rules in context step", () => {
    expect(content).toMatch(/skills\/rules\/tasks-generation\.md/)
  })

  it("uses boundary annotation format", () => {
    expect(content).toMatch(/_Boundary:/)
  })

  it("uses _Boundary: in proposal section", () => {
    const proposalIdx = content.indexOf("Conversational Proposal")
    const boundaryCount = (content.match(/_Boundary:/g) || []).length
    expect(boundaryCount).toBeGreaterThanOrEqual(2)
  })

  it("uses @mention syntax for sub-agents", () => {
    expect(content).toMatch(/@[\w-]+/)
  })

  it("references @speckit-reviewer and @explore as sub-agents", () => {
    expect(content).toMatch(/@speckit-reviewer/)
    expect(content).toMatch(/@explore/)
  })

  it("describes sub-agent dispatch for complex dependency graphs", () => {
    const hasDispatch = /sub-agent.*dispatch|dispatch.*sub-agent|dispatch sub-/i.test(content)
    const hasSubAgents = content.includes("Sub-agent dispatch")
    expect(hasDispatch || hasSubAgents).toBe(true)
  })

  it("has a quality checklist section", () => {
    expect(content).toMatch(/- \[ \]/)
  })

  it("quality checklist includes proposal, domain-map, boundary, @mention, rules items", () => {
    expect(content).toMatch(/proposal/i)
    expect(content).toMatch(/domain-map|domain map/i)
    expect(content).toMatch(/Boundary/)
    expect(content).toMatch(/@mention/)
    expect(content).toMatch(/skills\/rules/)
  })

  it("has a dedicated Reference section", () => {
    expect(content).toMatch(/## Reference/)
  })

  it("Reference section includes shared rules, sub-agents, domain map", () => {
    const refStart = content.indexOf("## Reference")
    const refBlock = content.slice(refStart)
    expect(refBlock).toMatch(/skills\/rules\//)
    expect(refBlock).toMatch(/@explore/)
    expect(refBlock).toMatch(/@speckit-reviewer/)
    expect(refBlock).toMatch(/domain-map\.md/)
  })

  it("has error handling sections", () => {
    expect(content).toMatch(/Error:/)
  })

  it("handles boundary overlap between tasks", () => {
    expect(content).toMatch(/Boundary overlap/i)
  })

  it("has a task format section with T-NNN structure", () => {
    expect(content).toMatch(/T-NNN/)
    expect(content).toMatch(/\[P\]/)
    expect(content).toMatch(/_Depends:/)
  })

  it("has a phase structure section", () => {
    expect(content).toMatch(/Phase \d/)
  })

  it("has an Output location section", () => {
    expect(content).toMatch(/Output location/)
  })
})
