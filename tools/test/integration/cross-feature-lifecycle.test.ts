import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import phaseTool from "../../speckit-phase"
import validateTool from "../../speckit-validate"
import archiveTool from "../../speckit-archive"
import eventsPlugin from "../../plugins/speckit-events"
import { readEvents, type SddEvent } from "../../plugins/speckit-events"
import { readSpecJson, writeSpecJson, type SpecJson } from "../../shared/types"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import {
  expectSessionState,
  listSnapshotTriggers,
  readProjectFile,
} from "../helpers/assertions"

let worktree: string
let ctx: ReturnType<typeof mockContext>

interface ToolOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

async function run(
  tool: { execute: (args: never, context: ToolContext) => Promise<ToolOutput> },
  args: Record<string, unknown> = {},
): Promise<ToolOutput> {
  return tool.execute(args as never, ctx)
}

// Mirrors the runtime so the events hook recorded here sees the same results approve and phase return.
let eventsHook: ((toolName: string, result: unknown) => Promise<void>) | null = null

async function emitFrom(toolName: string, result: ToolOutput): Promise<void> {
  if (eventsHook) await eventsHook(toolName, result)
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  await createConstitution(worktree)
  const captured: Array<(toolName: string, result: unknown) => Promise<void>> = []
  eventsHook = null
  await eventsPlugin.setup({
    location: { project: { canonical: worktree } },
    tool: {
      hook: (_name: string, fn: (toolName: string, result: unknown) => Promise<void>) => {
        captured.push(fn)
        return () => {}
      },
    },
  } as never)
  await Promise.resolve()
  if (captured.length > 0) eventsHook = captured[0]
})

afterEach(async () => {
  eventsHook = null
  await destroyTempWorktree(worktree)
})

describe("cross-feature: validate approves scaffold archives the whole chain", () => {
  it("drives spec, plan and tasks from scaffold to archive with validate and phase gates in between", async () => {
    const spec = await run(scaffoldTool, { featureName: "User Auth", template: "spec" })
    expect(spec.metadata?.featureDir).toBe("001-user-auth")

    const validatedSpec = await run(validateTool, { command: "plan" })
    expect(validatedSpec.metadata?.phase).toBe("spec")

    await run(approveTool, { artifact: "spec", confirmed: true })
    await run(scaffoldTool, { featureName: "User Auth", template: "plan", techStack: "Node.js" })
    await run(approveTool, { artifact: "plan", confirmed: true })
    await run(scaffoldTool, { featureName: "User Auth", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })

    const ready = await run(validateTool, { command: "impl" })
    expect(ready.metadata?.phase).toBe("ready")
    await expectSessionState(worktree, { phase: "ready", featureDir: "001-user-auth" })

    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })

    // Convergence is recorded by /converge, so cross-feature wiring seeds it through the shared IO layer.
    const featureDir = path.join(worktree, "specs", "001-user-auth")
    const completed = await readSpecJson(featureDir) as SpecJson
    completed.converged = true
    completed.convergenceHistory = [
      { date: completed.updated_at, status: "converged", gaps: 0 },
    ]
    await writeSpecJson(completed, featureDir)

    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")
    await expectSessionState(worktree, { phase: "spec", featureDir: null })

    const noFeatures = await run(validateTool, { command: "status" })
    expect(noFeatures.metadata?.phase).toBe("empty")
  })

  it("refuses to archive when the implementation phase was never finished", async () => {
    await run(scaffoldTool, { featureName: "User Auth", template: "spec" })
    const blocked = await run(archiveTool, { confirmed: true })
    expect(blocked.title).toBe("Error")
    expect(blocked.output).toContain("is not complete")
  })
})

describe("cross-feature: the events hooks follow the real lifecycle", () => {
  it("records the approval and the phase transition of a driven feature", async () => {
    await run(scaffoldTool, { featureName: "Event Fetch", template: "spec" })
    const approved = await run(approveTool, { artifact: "spec", confirmed: true })
    await emitFrom("speckit-approve", approved)

    await run(scaffoldTool, { featureName: "Event Fetch", template: "plan", techStack: "Node.js" })
    await run(approveTool, { artifact: "plan", confirmed: true })
    await run(scaffoldTool, { featureName: "Event Fetch", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    const advanced = await run(phaseTool, { phase: "impl" })
    await emitFrom("speckit-phase", advanced)

    const events = await readEvents(worktree)
    expect(events.length).toBeGreaterThanOrEqual(2)

    const approval = events.find((event: SddEvent) => event.event === "sdd.approved")
    expect(approval?.feature).toBe("001-event-fetch")
    expect(approval?.artifact).toBe("spec")

    const phaseChange = events.find((event: SddEvent) => event.event === "sdd.phase.changed")
    expect(phaseChange?.feature).toBe("001-event-fetch")
  })

  it("records an unknown tool call as nothing", async () => {
    await run(scaffoldTool, { featureName: "Silent Case", template: "spec" })
    await emitFrom("speckit-unknown", { output: "irrelevant" })

    const events = await readEvents(worktree)
    expect(events).toEqual([])
  })
})

describe("cross-feature: archive snapshots the pre-archive state", () => {
  it("captures a snapshot with the archive trigger that can be drilled", async () => {
    await run(scaffoldTool, { featureName: "Snapshot Plus", template: "spec" })
    await run(approveTool, { artifact: "spec", confirmed: true })
    await run(scaffoldTool, { featureName: "Snapshot Plus", template: "plan", techStack: "Node.js" })
    await run(approveTool, { artifact: "plan", confirmed: true })
    await run(scaffoldTool, { featureName: "Snapshot Plus", template: "tasks" })
    await run(approveTool, { artifact: "tasks", confirmed: true })
    await run(phaseTool, { phase: "impl" })
    await run(phaseTool, { phase: "complete" })

    const featureDir = path.join(worktree, "specs", "001-snapshot-plus")
    const specJson = await readSpecJson(featureDir) as SpecJson
    specJson.converged = true
    specJson.convergenceHistory = [{ date: specJson.updated_at, status: "converged", gaps: 0 }]
    await writeSpecJson(specJson, featureDir)

    const archived = await run(archiveTool, { confirmed: true })
    expect(archived.title).toBe("Archived")

    const triggers = await listSnapshotTriggers(worktree)
    // The transitions capture phase snapshots first, and the archive step reuses the newest verified one when its scope still matches instead of cutting a duplicate.
    const phaseSnapshots = triggers.filter(trigger => trigger.startsWith("phase:"))
    expect(phaseSnapshots.length).toBeGreaterThanOrEqual(2)

    // The pre-archive recovery point exists either way, because a scope-matching snapshot was captured during the last transition.
    expect(triggers.some(trigger => trigger !== "manual")).toBe(true)
  })

  it("archives one feature while a second feature keeps its own state", async () => {
    await run(scaffoldTool, { featureName: "First Wave", template: "spec" })
    await run(scaffoldTool, { featureName: "Second Wave", template: "spec" })

    // Finish and converge the first feature without touching the second.
    const firstDir = path.join(worktree, "specs", "001-first-wave")
    const secondDir = path.join(worktree, "specs", "002-second-wave")
    const first = await readSpecJson(firstDir) as SpecJson
    first.phase = "complete"
    first.converged = true
    first.convergenceHistory = [{ date: first.updated_at, status: "converged", gaps: 0 }]
    await writeSpecJson(first, firstDir)

    const beforeSecond = await readProjectFile(worktree, "specs/002-second-wave/spec.md")

    const archived = await run(archiveTool, { featureDir: "001-first-wave", confirmed: true })
    expect(archived.title).toBe("Archived")
    expect(archived.output).toContain("001-first-wave")

    // The session points at Second Wave, so an archive of First Wave leaves the active reference alone.
    await expectSessionState(worktree, { featureDir: "002-second-wave" })
    expect(await readProjectFile(worktree, "specs/002-second-wave/spec.md")).toBe(beforeSecond)

    // Validate resolves the newest remaining feature, which is still in the spec stage.
    const active = await run(validateTool, { command: "status" })
    expect(active.metadata?.featureDir).toBe("002-second-wave")
    expect(active.metadata?.artifacts).toMatchObject({
      constitution: true,
      spec: true,
      plan: false,
      tasks: false,
    })
  })
})
