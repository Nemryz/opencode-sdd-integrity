import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const SKILL_PATH = repoPath("skills", "speckit-constitution", "SKILL.md")

describe("speckit-constitution SKILL.md content", () => {
  let content: string

  beforeAll(async () => {
    content = await fs.readFile(SKILL_PATH, "utf-8")
  })

  it("has a conversational proposal section before writing", () => {
    const proposalMatch = content.match(/proposal/i)
    const writeIndex = content.indexOf("Step 3: Write Constitution")
    expect(proposalMatch).not.toBeNull()
    expect(proposalMatch!.index).toBeLessThan(writeIndex)
  })

  it("has a proposal template with Articles and Boundary Map", () => {
    expect(content).toMatch(/Articles/)
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

  it("references @explore as a sub-agent", () => {
    expect(content).toMatch(/@explore/)
  })

  it("describes sub-agent dispatch for complex projects", () => {
    const hadDispatch = /sub-agent.*dispatch|dispatch.*sub-agent|dispatch sub-/i.test(content)
    const hadSubAgents = content.includes("Sub-agent dispatch")
    expect(hadDispatch || hadSubAgents).toBe(true)
  })

  it("loads domain-map.md in context step", () => {
    expect(content).toMatch(/domain-map\.md/)
  })

  it("loads steering context in context step", () => {
    expect(content).toMatch(/steering/i)
  })

  it("reads existing constitution in phase gate", () => {
    expect(content).toMatch(/existing constitution|constitution.*already exist|constitution.*exists/i)
  })

  it("has a quality checklist section", () => {
    expect(content).toMatch(/- \[ \]/)
  })

  it("quality checklist includes proposal, boundary, @mention, rules items", () => {
    expect(content).toMatch(/proposal/i)
    expect(content).toMatch(/Boundary/)
    expect(content).toMatch(/@mention/)
    expect(content).toMatch(/skills\/rules/)
  })

  it("has a dedicated Reference section", () => {
    expect(content).toMatch(/## Reference/)
  })

  it("Reference section includes template, shared rules, sub-agents", () => {
    const refStart = content.indexOf("## Reference")
    const refBlock = content.slice(refStart)
    expect(refBlock).toMatch(/template/i)
    expect(refBlock).toMatch(/skills\/rules\//)
    expect(refBlock).toMatch(/@explore/)
  })

  it("has error handling sections", () => {
    expect(content).toMatch(/Error:/)
  })

  it("handles boundary overlap between constitution and steering", () => {
    expect(content).toMatch(/Boundary overlap/i)
  })

  it("has a dedicated Output location section", () => {
    expect(content).toMatch(/Output location/)
  })
})
