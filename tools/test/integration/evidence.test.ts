import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import evidenceTool from "../../speckit-evidence"
import auditTool, { type AuditFinding } from "../../speckit-audit"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  DEFAULT_SESSION,
  collectTaskIds,
  makeSpecJson,
  trimEvidenceEntries,
  writeSession,
  writeSpecJson,
} from "../../shared/types"
import type { EvidenceEntry, SpecJson } from "../../shared/types"

const TASKS = [
  "# Tasks: demo",
  "",
  "## Phase 1",
  "",
  "### T-001 Initialize",
  "- **Story**: Setup",
  "",
  "### T-002 [P] Models",
  "- **Story**: Setup",
  "",
  "### T-003 API",
  "- **Story**: P1",
  "",
].join("\n")

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

async function createFeature(dirName = "001-demo", options: { phase?: SpecJson["phase"]; tasks?: string } = {}) {
  const dir = path.join(worktree, "specs", dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "spec.md"), "# Spec: demo\n", "utf-8")
  await fs.writeFile(path.join(dir, "tasks.md"), options.tasks ?? TASKS, "utf-8")
  const sj = makeSpecJson("demo", 1)
  sj.phase = options.phase ?? "impl"
  await writeSpecJson(sj, dir)
  return dir
}

async function readEvidence(dir: string): Promise<{ updated_at: string; entries: EvidenceEntry[] }> {
  return JSON.parse(await fs.readFile(path.join(dir, "evidence.json"), "utf-8"))
}

describe("evidence recording", () => {
  it("records an entry with the exact command and exit code", async () => {
    const dir = await createFeature()
    const result = await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test", exitCode: 0 }, ctx)

    expect(result.title).toBe("Evidence: T-001")
    expect(result.output).toContain("npm test recorded with exit 0")
    const file = await readEvidence(dir)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0].task).toBe("T-001")
    expect(file.entries[0].test_command).toBe("npm test")
    expect(file.entries[0].exit_code).toBe(0)
    expect(Number.isNaN(Date.parse(file.entries[0].at))).toBe(false)
    expect(file.updated_at).toBe(file.entries[0].at)
  })

  it("defaults the task to feature and the exit code to zero", async () => {
    const dir = await createFeature()
    await evidenceTool.execute({ command: "record", testCommand: "npm run build" }, ctx)

    const file = await readEvidence(dir)
    expect(file.entries[0].task).toBe("feature")
    expect(file.entries[0].exit_code).toBe(0)
  })

  it("appends entries in order and stores an optional note", async () => {
    const dir = await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)
    const second = await evidenceTool.execute(
      { command: "record", task: "T-002", testCommand: "npm test", exitCode: 1, note: "flaky suite" },
      ctx,
    )

    expect(second.metadata?.entries).toBe(2)
    const file = await readEvidence(dir)
    expect(file.entries.map(e => e.task)).toEqual(["T-001", "T-002"])
    expect(file.entries[1].note).toBe("flaky suite")
    expect(file.entries[1].exit_code).toBe(1)
  })

  it("keeps a verified backup of the previous file", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)
    await evidenceTool.execute({ command: "record", task: "T-002", testCommand: "npm test" }, ctx)

    const backups = await fs.readdir(path.join(worktree, ".opencode", "backups"))
    expect(backups.some(name => name.includes("evidence") && name.endsWith(".bak"))).toBe(true)
  })

  it("refuses a blank test command", async () => {
    const dir = await createFeature()
    const result = await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "   " }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("testCommand is required")
    await expect(fs.access(path.join(dir, "evidence.json"))).rejects.toThrow()
  })

  it("refuses to overwrite a corrupt evidence file", async () => {
    const dir = await createFeature()
    const fp = path.join(dir, "evidence.json")
    await fs.writeFile(fp, "{not json", "utf-8")

    const result = await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("corrupt or invalid")
    expect(await fs.readFile(fp, "utf-8")).toBe("{not json")
  })

  it("rejects an unsafe featureDir", async () => {
    await createFeature()
    const result = await evidenceTool.execute({ command: "record", testCommand: "npm test", featureDir: "../etc" }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("Invalid featureDir")
  })

  it("errors when no feature exists", async () => {
    const result = await evidenceTool.execute({ command: "record", testCommand: "npm test" }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("No feature found")
  })

  it("errors when the feature has no spec.md", async () => {
    const dir = path.join(worktree, "specs", "001-demo")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "tasks.md"), TASKS, "utf-8")

    const result = await evidenceTool.execute({ command: "record", testCommand: "npm test" }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("has no spec.md")
  })

  it("resolves the feature from the session when several exist", async () => {
    await createFeature("001-demo")
    const other = await createFeature("002-other")
    await writeSession(worktree, { ...DEFAULT_SESSION, featureDir: "002-other", featureName: "other", featureNumber: 2 })

    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)

    const file = await readEvidence(other)
    expect(file.entries).toHaveLength(1)
    await expect(fs.access(path.join(worktree, "specs", "001-demo", "evidence.json"))).rejects.toThrow()
  })

  it("keeps every entry when parallel tasks record at the same time", async () => {
    const dir = await createFeature()
    const tasks = ["T-001", "T-002", "T-003", "T-004", "T-005"]
    const results = await Promise.all(
      tasks.map(task => evidenceTool.execute({ command: "record", task, testCommand: "npm test" }, ctx)),
    )

    expect(results.every(result => result.title !== "Error")).toBe(true)
    const file = await readEvidence(dir)
    expect(file.entries.map(entry => entry.task).sort()).toEqual(tasks)
  })

  it("caps the log by dropping the oldest recorded entry", async () => {
    const dir = await createFeature()
    const seeded = Array.from({ length: 500 }, (_, index) => ({
      task: `T-${String(index + 1).padStart(3, "0")}`,
      test_command: "npm test",
      exit_code: 0,
      at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    }))
    await fs.writeFile(
      path.join(dir, "evidence.json"),
      JSON.stringify({ feature: "001-demo", updated_at: seeded[0].at, entries: seeded }, null, 2),
      "utf-8",
    )

    await evidenceTool.execute({ command: "record", task: "T-999", testCommand: "npm test" }, ctx)

    const file = await readEvidence(dir)
    expect(file.entries).toHaveLength(500)
    expect(file.entries[0].task).not.toBe("T-001")
    expect(file.entries[file.entries.length - 1].task).toBe("T-999")
  })

  it("truncates fractional exit codes and keeps unicode notes", async () => {
    const dir = await createFeature()
    await evidenceTool.execute(
      { command: "record", task: "T-001", testCommand: "npm test", exitCode: 1.9, note: "prueba ñandú 漢字" },
      ctx,
    )

    const file = await readEvidence(dir)
    expect(file.entries[0].exit_code).toBe(1)
    expect(file.entries[0].note).toBe("prueba ñandú 漢字")
  })
})

describe("evidence status", () => {
  it("reports no evidence when the log is empty", async () => {
    await createFeature()
    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).toContain("No test evidence recorded yet")
    expect(result.metadata?.entries).toBe(0)
  })

  it("reports coverage, missing tasks and failing latest runs", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test", exitCode: 0 }, ctx)
    await evidenceTool.execute({ command: "record", task: "T-002", testCommand: "npm test", exitCode: 1 }, ctx)

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).toContain("2/3 tasks covered (2 entries)")
    expect(result.output).toContain("missing: T-003")
    expect(result.output).toContain("failing latest: T-002 (npm test, exit 1)")
    expect(result.metadata?.covered).toBe(2)
  })

  it("stops reporting a failure once a later green run exists", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test", exitCode: 1 }, ctx)
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test", exitCode: 0 }, ctx)

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).not.toContain("failing latest")
    expect(result.output).toContain("1/3 tasks covered")
  })

  it("counts feature level entries without covering tasks", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", testCommand: "npm run build" }, ctx)

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).toContain("0/3 tasks covered (1 entry)")
    expect(result.output).toContain("missing: T-001, T-002, T-003")
  })

  it("handles a tasks file without task IDs", async () => {
    await createFeature("001-demo", { tasks: "# Tasks\n\nNo identifiers here\n" })
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).toContain("no task IDs found in tasks.md")
  })

  it("reports a corrupt evidence file instead of reading it", async () => {
    const dir = await createFeature()
    await fs.writeFile(path.join(dir, "evidence.json"), "{broken", "utf-8")

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.title).toBe("Error")
    expect(result.output).toContain("corrupt or invalid")
  })

  it("reads a byte order mark in the evidence file", async () => {
    const dir = await createFeature()
    const payload = JSON.stringify({
      feature: "001-demo",
      updated_at: "2026-10-19T00:00:00.000Z",
      entries: [{ task: "T-001", test_command: "npm test", exit_code: 0, at: "2026-10-19T00:00:00.000Z" }],
    })
    await fs.writeFile(path.join(dir, "evidence.json"), "\uFEFF" + payload, "utf-8")

    const result = await evidenceTool.execute({ command: "status" }, ctx)

    expect(result.output).toContain("1/3 tasks covered (1 entry)")
  })
})

describe("evidence helpers", () => {
  it.each([
    ["a level 3 heading", "### T-001 Initialize the project", ["T-001"]],
    ["a parallel marker", "### [P] T-002 Configure storage", ["T-002"]],
    ["a checkbox item", "- [ ] T-003 wire the API\n- [x] T-004 ship the CLI", ["T-003", "T-004"]],
    ["indented headings", "    ### T-005 nested", ["T-005"]],
    ["a level 6 heading", "###### T-006 deep", ["T-006"]],
    ["the document title only", "# T-000 title", []],
    ["an inline mention only", "See T-007 for details.", []],
    ["a lowercase identifier only", "### t-008 lower", []],
    ["four digit numbers", "### T-1234 wide", ["T-1234"]],
    ["windows line endings", "### T-009 first\r\n### T-010 second\r\n", ["T-009", "T-010"]],
  ])("collectTaskIds reads %s", (_label, content, expected) => {
    expect(collectTaskIds(content)).toEqual(expected)
  })

  it("collectTaskIds deduplicates repeated identifiers", () => {
    expect(collectTaskIds("### T-001 one\n\n### T-001 again")).toEqual(["T-001"])
  })

  it("trimEvidenceEntries keeps everything below the cap", () => {
    const entries = [{ task: "T-001", test_command: "npm test", exit_code: 0, at: "now" }]
    expect(trimEvidenceEntries(entries, 500)).toBe(entries)
  })

  it("trimEvidenceEntries drops the oldest entries above the cap", () => {
    const entries: EvidenceEntry[] = ["T-001", "T-002", "T-003", "T-004"].map((task) => ({
      task,
      test_command: "npm test",
      exit_code: 0,
      at: "now",
    }))
    expect(trimEvidenceEntries(entries, 2).map(e => e.task)).toEqual(["T-003", "T-004"])
  })
})

describe("audit evidence findings", () => {
  function findingsFor(result: { metadata?: Record<string, unknown> }, category: string): AuditFinding[] {
    const findings = (result.metadata?.findings ?? []) as AuditFinding[]
    return findings.filter(f => f.category === category)
  }

  it("warns when an impl feature has no evidence recorded", async () => {
    await createFeature()
    const result = await auditTool.execute({}, ctx)

    const missing = findingsFor(result, "evidence-missing")
    expect(missing).toHaveLength(1)
    expect(missing[0].severity).toBe("warn")
    expect(missing[0].message).toContain("impl phase has no test evidence")
  })

  it("stays quiet before implementation starts", async () => {
    await createFeature("001-demo", { phase: "ready" })
    const result = await auditTool.execute({}, ctx)

    const findings = (result.metadata?.findings ?? []) as AuditFinding[]
    expect(findings.filter(f => f.category.startsWith("evidence"))).toHaveLength(0)
  })

  it("flags a failing latest run as a warning", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test", exitCode: 1 }, ctx)
    await evidenceTool.execute({ command: "record", task: "T-002", testCommand: "npm test", exitCode: 0 }, ctx)
    const result = await auditTool.execute({}, ctx)

    const failing = findingsFor(result, "evidence-failing")
    expect(failing).toHaveLength(1)
    expect(failing[0].severity).toBe("warn")
    expect(failing[0].message).toContain("latest evidence for T-001 is a failing run (npm test, exit 1)")
  })

  it("aggregates tasks without evidence into one info finding", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)
    const result = await auditTool.execute({}, ctx)

    const gap = findingsFor(result, "evidence-gap")
    expect(gap).toHaveLength(1)
    expect(gap[0].severity).toBe("info")
    expect(gap[0].message).toContain("2 tasks have no test evidence (T-002, T-003)")
  })

  it("truncates the missing list after five identifiers", async () => {
    const longTasks = ["# Tasks", ...Array.from({ length: 8 }, (_, i) => `### T-00${i + 1} task`), ""].join("\n")
    await createFeature("001-demo", { tasks: longTasks })
    await evidenceTool.execute({ command: "record", task: "T-001", testCommand: "npm test" }, ctx)
    const result = await auditTool.execute({}, ctx)

    const gap = findingsFor(result, "evidence-gap")
    expect(gap[0].message).toContain("7 tasks have no test evidence (T-002, T-003, T-004, T-005, T-006 and more)")
  })

  it("warns about a corrupt evidence file", async () => {
    const dir = await createFeature()
    await fs.writeFile(path.join(dir, "evidence.json"), "{broken", "utf-8")
    const result = await auditTool.execute({}, ctx)

    const corrupt = findingsFor(result, "evidence-corrupt")
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0].severity).toBe("warn")
  })

  it("warns about a failing feature level run and clears it with a green rerun", async () => {
    await createFeature()
    await evidenceTool.execute({ command: "record", task: "phase-1", testCommand: "npm run test:all", exitCode: 2 }, ctx)

    const failing = findingsFor(await auditTool.execute({}, ctx), "evidence-failing")
    expect(failing).toHaveLength(1)
    expect(failing[0].message).toContain("latest feature-level evidence is a failing run (npm run test:all, exit 2)")

    await evidenceTool.execute({ command: "record", task: "phase-1", testCommand: "npm run test:all", exitCode: 0 }, ctx)
    expect(findingsFor(await auditTool.execute({}, ctx), "evidence-failing")).toHaveLength(0)
  })
})
