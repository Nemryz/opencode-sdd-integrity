import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import phaseTool from "../../speckit-phase"
import validateTool from "../../speckit-validate"
import evidenceTool from "../../speckit-evidence"
import archiveTool from "../../speckit-archive"
import { emitEvent } from "../../plugins/speckit-events"
import { readEvents, type SddEvent } from "../../plugins/speckit-events"
import { readSpecJson, writeSpecJson, type SpecJson, type EvidenceFile } from "../../shared/types"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { expectSessionState } from "../helpers/assertions"

let worktree: string
let ctx: ReturnType<typeof mockContext>

interface ToolOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

interface EvidenceStatus {
  entries: number
  tasks: number
  covered: number
  missing: string[]
  failing: string[]
}

async function run(
  tool: { execute: (args: never, context: ToolContext) => Promise<ToolOutput> },
  args: Record<string, unknown> = {},
): Promise<ToolOutput> {
  return tool.execute(args as never, ctx)
}

async function evidenceStatus(featureDir: string): Promise<EvidenceStatus> {
  const res = await run(evidenceTool, { command: "status", featureDir: path.basename(featureDir) })
  return res.metadata as unknown as EvidenceStatus
}

// Simulates one agent pass of the converger skill over the driven artifacts, so the E2E stays on real tool behavior.
async function converge(featureDir: string): Promise<void> {
  const spec = await readSpecJson(featureDir) as SpecJson
  const status = await evidenceStatus(featureDir)
  const converged = status.missing.length === 0 && status.failing.length === 0
  spec.converged = converged
  spec.convergenceHistory = [
    ...(spec.convergenceHistory ?? []),
    { date: new Date().toISOString(), status: converged ? "converged" : "not-converged", gaps: status.missing.length + status.failing.length },
  ]
  spec.updated_at = new Date().toISOString()
  await writeSpecJson(spec, featureDir)
}

async function approvedThroughTasks(featureName: string): Promise<string> {
  await run(scaffoldTool, { featureName, template: "spec" })
  await run(approveTool, { artifact: "spec", confirmed: true })
  await run(scaffoldTool, { featureName, template: "plan", techStack: "Node.js" })
  await run(approveTool, { artifact: "plan", confirmed: true })
  const created = await run(scaffoldTool, { featureName, template: "tasks" })
  await run(approveTool, { artifact: "tasks", confirmed: true })
  return created.metadata?.featureDir as string
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  await createConstitution(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("e2e: converge and archive close the lifecycle with evidence on disk", () => {
  it("drives spec, plan, tasks, evidence, impl to complete, a converged convergence check and archive", async () => {
    const featureDir = path.join(worktree, "specs", await approvedThroughTasks("Search Rank"))

    // The implementer writes a real task breakdown, then records evidence per task.
    const tasksMd = "# Tasks\n\n## Setup\n- [ ] T-001 Create shared folder\n\n## Implementation\n- [ ] T-002 Rank scoring\n\n## Testing\n- [ ] T-003 Integration tests\n"
    await fs.writeFile(path.join(featureDir, "tasks.md"), tasksMd, "utf-8")
    for (const task of ["T-001", "T-002", "T-003"]) {
      await run(evidenceTool, { command: "record", task, testCommand: "npx vitest run", exitCode: 0, note: "green", featureDir: "001-search-rank" })
    }

    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })
    expect((await readSpecJson(featureDir) as SpecJson).phase).toBe("complete")

    // The convergence check finds no gaps and no failing exits, so it converges.
    const before = await evidenceStatus(featureDir)
    expect(before.covered).toBe(3)
    expect(before.missing).toEqual([])
    await converge(featureDir)

    const spec = await readSpecJson(featureDir) as SpecJson
    expect(spec.converged).toBe(true)
    expect(spec.convergenceHistory).toHaveLength(1)
    expect(spec.convergenceHistory?.[0]).toMatchObject({ status: "converged", gaps: 0 })

    // Evidence stays attached to the tasks it proved.
    const evidence = await fs.readFile(path.join(featureDir, "evidence.json"), "utf-8") as unknown as string
    expect(JSON.parse(evidence) as EvidenceFile).toMatchObject({ feature: "001-search-rank", entries: [{ task: "T-001" }, { task: "T-002" }, { task: "T-003" }] })

    // Archiving the finished feature moves it and resets the active session.
    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")
    expect(archived.output).toContain("001-search-rank")
    await expectSessionState(worktree, { phase: "spec", featureDir: null })

    const empty = await run(validateTool, { command: "status" })
    expect(empty.metadata?.phase).toBe("empty")
  })

  it("blocks the archive call while a task misses evidence and proceeds once confirmed", async () => {
    const featureDir = path.join(worktree, "specs", await approvedThroughTasks("Gap Case"))

    await fs.writeFile(path.join(featureDir, "tasks.md"), "# Tasks\n- [ ] T-001 Done\n- [ ] T-002 Missing\n", "utf-8")
    await run(evidenceTool, { command: "record", task: "T-001", testCommand: "npx vitest run", exitCode: 0, featureDir: "001-gap-case" })

    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })
    await converge(featureDir)

    const spec = await readSpecJson(featureDir) as SpecJson
    expect(spec.converged).toBe(false)
    expect(spec.convergenceHistory?.[0]).toMatchObject({ status: "not-converged", gaps: 1 })

    // The convergence-led archive refuses until the user answers the warning explicitly.
    const warned = await run(archiveTool, {})
    expect(warned.title).toBe("Warning")
    expect(warned.metadata?.requiresConfirmation).toBe(true)
    expect(warned.output).toContain("has not converged")

    const second = await run(archiveTool, {})
    expect(second.title).toBe("Warning")
    expect(second.metadata?.requiresConfirmation).toBe(true)

    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")
    expect(archived.output).toContain("001-gap-case")
  })

  it("converges again after the agent fixes the missing evidence", async () => {
    const featureDir = path.join(worktree, "specs", await approvedThroughTasks("Retry Case"))

    await fs.writeFile(path.join(featureDir, "tasks.md"), "# Tasks\n- [ ] T-001 First\n- [ ] T-002 Second\n", "utf-8")
    await run(evidenceTool, { command: "record", task: "T-001", testCommand: "npx vitest run", exitCode: 0, featureDir: "001-retry-case" })

    // Phase gates still allow the feature to enter implementation with one task evidenced.
    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })
    await converge(featureDir)
    expect((await readSpecJson(featureDir) as SpecJson).converged).toBe(false)

    // The agent records the missing task and the convergence check passes on the next run.
    await run(evidenceTool, { command: "record", task: "T-002", testCommand: "npx vitest run", exitCode: 0, featureDir: "001-retry-case" })
    await converge(featureDir)

    const spec = await readSpecJson(featureDir) as SpecJson
    expect(spec.converged).toBe(true)
    expect(spec.convergenceHistory).toHaveLength(2)
    expect(spec.convergenceHistory?.[1]).toMatchObject({ status: "converged", gaps: 0 })

    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")
  })
})

describe("e2e: lifecycle events follow the driven feature end to end", () => {
  it("emits approval, convergence and archive events while the feature moves through the real tools", async () => {
    const featureDir = path.join(worktree, "specs", await approvedThroughTasks("Event Whole"))

    await run(evidenceTool, { command: "record", task: "T-001", testCommand: "npx vitest run", exitCode: 0, featureDir: "001-event-whole" })
    await fs.writeFile(path.join(featureDir, "tasks.md"), "# Tasks\n- [ ] T-001 Everything\n", "utf-8")
    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })
    await converge(featureDir)

    await emitEvent(worktree, { event: "sdd.approved", feature: "001-event-whole", timestamp: "2026-01-02T03:04:05Z", artifact: "tasks" })
    await emitEvent(worktree, { event: "sdd.converged", feature: "001-event-whole", timestamp: "2026-01-02T03:04:06Z" })

    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")
    await emitEvent(worktree, { event: "sdd.archived", feature: "001-event-whole", timestamp: "2026-01-02T03:04:07Z", archivePath: path.basename(archived.metadata?.archivePath as string) })

    const events = await readEvents(worktree) as SddEvent[]
    const kinds = events.map(event => event.event)
    expect(kinds).toEqual(["sdd.approved", "sdd.converged", "sdd.archived"])
    expect(events[0]).toMatchObject({ artifact: "tasks", feature: "001-event-whole" })

    // The archive marker carries the sibling path the toolkit chose, with collisions handled by the counter.
    expect(events[2]?.archivePath).toMatch(/001-event-whole/)
    const stillThere = await fs.access(path.join(worktree, "specs", "001-event-whole")).then(() => true).catch(() => false)
    expect(stillThere).toBe(false)
  })
})
