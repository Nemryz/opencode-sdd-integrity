import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import statusTool from "../../speckit-status"
import auditTool from "../../speckit-audit"
import validateTool from "../../speckit-validate"
import healthTool from "../../speckit-health"
import deltaTool from "../../speckit-delta"
import snapshotTool from "../../speckit-snapshot"
import complexityTool from "../../speckit-complexity"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import { writeSession, writeSpecJson, writeConfigWithBackup } from "../../shared/io"
import { SessionStateSchema, SpecJsonSchema } from "../../shared/schemas"
import type { SessionState, SpecJson } from "../../shared/schemas"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

function normalizeOutput(output: string): string {
  return output
    .replace(/[A-Z]:\\[^\s]+/g, "<PATH>")
    .replace(/\/tmp\/[^\s]+/g, "<PATH>")
    .replace(/\/var\/folders\/[^\s]+/g, "<PATH>")
    // Snapshot ids carry a local timestamp, so they are replaced to keep the snapshot stable.
    .replace(/\d{8}-\d{6}-[a-z0-9-]+/g, "<SNAPSHOT>")
    // Manifest timestamps change on every run, so they are replaced for the same reason.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TIMESTAMP>")
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    command: null,
    phase: "init",
    featureDir: null,
    featureNumber: null,
    featureName: null,
    nextStep: "/spec <description>",
    lastResult: null,
    history: [],
    ...overrides,
  }
}

function makeSpecJson(overrides?: Partial<SpecJson>): SpecJson {
  return {
    feature_name: "test",
    feature_number: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    phase: "spec",
    approvals: {
      spec: { generated: true, approved: false },
      plan: { generated: false, approved: false },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
    ...overrides,
  }
}

// /status (clean state)

describe("Snapshot: /status (clean state)", () => {
  it("matches snapshot for clean state", async () => {
    await createConstitution(worktree)
    const result = await statusTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /status (with corruption)

describe("Snapshot: /status (with corruption)", () => {
  it("matches snapshot with corruption warnings", async () => {
    await createConstitution(worktree)
    const fp = path.join(worktree, ".opencode", "spec-memory", "session.json")
    await fs.writeFile(fp, "invalid json {{{", "utf-8")
    const result = await statusTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(normalizeOutput(result.output)).toMatchSnapshot()
  })
})

// /audit (clean)

describe("Snapshot: /audit (clean)", () => {
  it("matches snapshot for clean audit", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await auditTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /audit (with findings)

describe("Snapshot: /audit (with findings)", () => {
  it("matches snapshot for audit with findings", async () => {
    await createConstitution(worktree)
    const featureDir = path.join(worktree, "specs", "001-test-feature")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "spec.md"), "# Spec\n", "utf-8")
    const sj = makeSpecJson({ phase: "ready" })
    await fs.writeFile(path.join(featureDir, "spec.json"), JSON.stringify(sj, null, 2), "utf-8")
    const result = await auditTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /validate (spec phase)

describe("Snapshot: /validate (spec phase)", () => {
  it("matches snapshot for spec phase validation", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await validateTool.execute({ command: "validate" }, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /validate (ready phase)

describe("Snapshot: /validate (ready phase)", () => {
  it("matches snapshot for ready phase validation", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "plan" }, ctx)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "tasks" }, ctx)
    const featureDir = path.join(worktree, "specs", "001-test-feature")
    const sj = makeSpecJson({ phase: "ready", ready_for_implementation: true })
    await fs.writeFile(path.join(featureDir, "spec.json"), JSON.stringify(sj, null, 2), "utf-8")
    const result = await validateTool.execute({ command: "validate" }, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /health (healthy)

describe("Snapshot: /health (healthy)", () => {
  it("matches snapshot for healthy state", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await healthTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /health (corrupted)

describe("Snapshot: /health (corrupted)", () => {
  it("matches snapshot for corrupted state", async () => {
    await createConstitution(worktree)
    const fp = path.join(worktree, ".opencode", "spec-memory", "session.json")
    await fs.writeFile(fp, "invalid json {{{", "utf-8")
    const result = await healthTool.execute({}, ctx)
    expect(result.title).toMatchSnapshot()
    expect(normalizeOutput(result.output)).toMatchSnapshot()
  })
})

// /delta-status (empty)

describe("Snapshot: /delta-status (empty)", () => {
  it("matches snapshot for empty deltas", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const result = await deltaTool.execute({ command: "delta-status" }, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /delta-status (with deltas)

describe("Snapshot: /delta-status (with deltas)", () => {
  it("matches snapshot for deltas present", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    await deltaTool.execute({ command: "spec-delta", description: "Add OAuth support" }, ctx)
    await deltaTool.execute({ command: "spec-delta", description: "Add rate limiting" }, ctx)
    const result = await deltaTool.execute({ command: "delta-status" }, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /complexity (simple task)

describe("Snapshot: /complexity (simple task)", () => {
  it("matches snapshot for simple task", async () => {
    const result = await complexityTool.execute(
      { taskDescription: "Add a button to the header" },
      ctx,
    )
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /complexity (complex task)

describe("Snapshot: /complexity (complex task)", () => {
  it("matches snapshot for complex task", async () => {
    const result = await complexityTool.execute(
      {
        taskDescription: "Implement distributed caching with Redis cluster, add monitoring dashboard, and refactor auth module",
        filesAffected: 25,
        hasNewDependencies: true,
        hasBoundaryAnnotations: true,
        hasNeedsClarification: true,
      },
      ctx,
    )
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /snapshot (empty project)

describe("Snapshot: /snapshot (empty project)", () => {
  it("matches snapshot for an empty project", async () => {
    await createConstitution(worktree)
    const result = await snapshotTool.execute({ subcommand: "list" }, ctx)
    expect(result.title).toMatchSnapshot()
    expect(result.output).toMatchSnapshot()
  })
})

// /snapshot (after create)

describe("Snapshot: /snapshot (after create)", () => {
  it("matches snapshot for the created snapshot", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Test Feature", template: "spec" }, ctx)
    const created = await snapshotTool.execute({ subcommand: "create" }, ctx)
    const listed = await snapshotTool.execute({ subcommand: "list" }, ctx)
    const preview = await snapshotTool.execute({
      subcommand: "preview",
      id: created.metadata?.snapshotId as string,
    }, ctx)
    expect(created.title).toMatchSnapshot()
    expect(normalizeOutput(created.output)).toMatchSnapshot()
    expect(listed.title).toMatchSnapshot()
    expect(normalizeOutput(listed.output)).toMatchSnapshot()
    expect(preview.title).toMatchSnapshot()
    expect(normalizeOutput(preview.output)).toMatchSnapshot()
  })
})

// /snapshot (after drill)

describe("Snapshot: /snapshot (after drill)", () => {
  it("matches snapshot for a drilled snapshot", async () => {
    await createConstitution(worktree)
    const created = await snapshotTool.execute({ subcommand: "create" }, ctx)
    await snapshotTool.execute({ subcommand: "drill", id: created.metadata?.snapshotId as string }, ctx)
    const listed = await snapshotTool.execute({ subcommand: "list" }, ctx)
    expect(listed.title).toMatchSnapshot()
    expect(normalizeOutput(listed.output)).toMatchSnapshot()
  })
})
