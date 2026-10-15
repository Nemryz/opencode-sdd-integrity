import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import auditTool from "../../speckit-audit"
import selfhealTool from "../../speckit-selfheal"
import perfTool from "../../speckit-perf"
import scaffoldTool from "../../speckit-scaffold"
import { mockContext, createTempWorktree, destroyTempWorktree, createConstitution } from "../helpers/setup"
import {
  readSession,
  writeSession,
  specsDirPath,
  DEFAULT_SESSION,
  getProjectRootWarnings,
  isValidProjectRoot,
} from "../../shared/types"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

function makeSpecJsonFixture(featureName: string, featureNumber: number, generated: boolean) {
  const now = new Date().toISOString()
  return {
    feature_name: featureName,
    feature_number: featureNumber,
    created_at: now,
    updated_at: now,
    phase: "spec",
    approvals: {
      spec: { generated, approved: false },
      plan: { generated: false, approved: false },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
  }
}

describe("audit --fix severity accounting", () => {
  it("does not reach PASS when only info findings were fixed", async () => {
    await createConstitution(worktree)
    const specsDir = specsDirPath(worktree)

    const d1 = path.join(specsDir, "001-fm")
    await fs.mkdir(d1, { recursive: true })
    await fs.writeFile(
      path.join(d1, "spec.md"),
      "---\nfeature_name: Fm\nfeature_number: 1\nphase: ready\n---\n\n# Spec\n",
      "utf-8",
    )

    const d2 = path.join(specsDir, "002-approval")
    await fs.mkdir(d2, { recursive: true })
    await fs.writeFile(path.join(d2, "spec.md"), "# Spec\n", "utf-8")
    await fs.writeFile(path.join(d2, "spec.json"), JSON.stringify(makeSpecJsonFixture("Approval", 2, false)), "utf-8")

    const result = await auditTool.execute({ fix: true }, ctx)
    expect(result.metadata?.passed).toBe(false)
    expect(result.metadata?.errorCount).toBeGreaterThanOrEqual(1)
  })

  it("reports feature corruption detected during the same run", async () => {
    await createConstitution(worktree)
    const d1 = path.join(specsDirPath(worktree), "001-broken")
    await fs.mkdir(d1, { recursive: true })
    await fs.writeFile(path.join(d1, "spec.md"), "# Spec\n", "utf-8")
    await fs.writeFile(path.join(d1, "spec.json"), "{corrupt json", "utf-8")

    const result = await auditTool.execute({}, ctx)
    const findings = (result.metadata?.findings ?? []) as Array<{ category: string }>
    expect(findings.some(f => f.category === "corruption")).toBe(true)
  })
})

describe("selfheal clean issue parsing", () => {
  it("includes clean issue messages in findings", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const sjPath = path.join(specsDirPath(worktree), "001-auth", "spec.json")
    const raw = JSON.parse(await fs.readFile(sjPath, "utf-8"))
    raw.phase = "plan"
    await fs.writeFile(sjPath, JSON.stringify(raw, null, 2), "utf-8")

    const result = await selfhealTool.execute({}, ctx)
    const meta = result.metadata as { findings: Array<{ source: string; message: string }> }
    const cleanFindings = meta.findings.filter(f => f.source === "clean")
    expect(cleanFindings.length).toBeGreaterThan(0)
    for (const f of cleanFindings) {
      expect(f.message.length).toBeGreaterThan(0)
    }
  })
})

describe("perf tool guards", () => {
  it("returns error for invalid project root instead of throwing", async () => {
    const badCtx = mockContext(path.join(worktree, "nope"))
    const result = await perfTool.execute({}, badCtx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Not a valid project directory")
  })

  it("returns error when no worktree", async () => {
    const result = await perfTool.execute({}, { worktree: "" } as never)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("No worktree path")
  })

  it("handles corrupt perf.json", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "perf.json"), "not json", "utf-8")
    const result = await perfTool.execute({}, ctx)
    expect(result.title).toBe("Performance Data")
  })

  it("handles perf.json with malformed stats", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "perf.json"), JSON.stringify({ stats: "nope" }), "utf-8")
    const result = await perfTool.execute({}, ctx)
    expect(result.title).toBe("Performance Data")
  })

  it("reports stats with valid data", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "perf.json"), JSON.stringify({
      lastUpdated: new Date().toISOString(),
      stats: [{ tool: "speckit-audit", calls: 3, totalTime: 300, times: [100], p50: 100, p95: 100, p99: 100, avg: 100 }],
    }), "utf-8")
    const result = await perfTool.execute({}, ctx)
    expect(result.title).toBe("Tool Performance Report")
    expect(result.output).toContain("speckit-audit")
  })
})

describe("scaffold missing spec warning", () => {
  it("warns when scaffolding plan without a spec", async () => {
    await createConstitution(worktree)
    const result = await scaffoldTool.execute({ featureName: "NoSpec", template: "plan" }, ctx)
    expect(result.metadata?.missingSpec).toBe(true)
    expect(result.output).toContain("no spec.md")
  })

  it("does not warn when spec exists", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Auth", template: "spec" }, ctx)
    const result = await scaffoldTool.execute({ featureName: "Auth", template: "plan" }, ctx)
    expect(result.metadata?.missingSpec).toBe(false)
    expect(result.output).not.toContain("no spec.md")
  })

  it("errors on ambiguous feature for data-model with multiple features", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Alpha", template: "spec" }, ctx)
    await scaffoldTool.execute({ featureName: "Beta", template: "spec" }, ctx)
    const result = await scaffoldTool.execute({ featureName: "NoMatch", template: "data-model" }, ctx)
    expect(result.title).toBe("Error")
    expect(result.output).toContain("No matching feature directory")
  })

  it("uses the only feature for data-model when unambiguous", async () => {
    await createConstitution(worktree)
    await scaffoldTool.execute({ featureName: "Alpha", template: "spec" }, ctx)
    const result = await scaffoldTool.execute({ featureName: "NoMatch", template: "data-model" }, ctx)
    expect(result.title).toBe("data-model.md created")
  })
})

describe("session history cap", () => {
  it("trims history to 20 entries on write", async () => {
    const history = Array.from({ length: 25 }, (_, i) => `/cmd${i}`)
    await writeSession(worktree, { ...DEFAULT_SESSION, history })
    const session = await readSession(worktree)
    expect(session.history).toHaveLength(20)
    expect(session.history[0]).toBe("/cmd5")
    expect(session.history[session.history.length - 1]).toBe("/cmd24")
  })
})

describe("project root hardening", () => {
  it("rejects a project root whose .opencode is a symlink", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "b6-real-"))
    await fs.mkdir(path.join(real, "spec-memory"), { recursive: true })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "b6-link-"))
    let linked = false
    try {
      await fs.symlink(real, path.join(root, ".opencode"), "junction")
      linked = true
    } catch {
      // symlink creation unavailable in this environment
    }
    try {
      if (!linked) return
      expect(await isValidProjectRoot(root)).toBe(false)
    } finally {
      await fs.rm(real, { recursive: true, force: true })
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // Linux filesystems are case-sensitive, so case-variation scenarios cannot be reproduced there.
  it.skipIf(process.platform === "linux")("detects kit dir with different case", async () => {
    const kitDir = path.join(os.homedir(), ".config", "opencode")
    const warnings = await getProjectRootWarnings(kitDir.toUpperCase())
    expect(warnings.some(w => w.type === "kit-installation")).toBe(true)
  })
})
