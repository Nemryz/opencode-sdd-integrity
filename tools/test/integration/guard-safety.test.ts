import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import guardPlugin, {
  DEFAULT_CONFIG,
  GuardConfigSchema,
  isProtectedFile,
  isProtectedAfterApproval,
  isProtectedByPhase,
  isInFeatureDir,
  normalizeGuardPath,
  extractRedirectTargets,
} from "../../plugins/speckit-guard"
import guardTool from "../../speckit-guard"
import { mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeEach(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

async function runHook(type: string, pattern: string | string[]): Promise<{ status: string }> {
  const hooks = await guardPlugin.server({ worktree } as never)
  const output = { status: "ask" }
  await hooks["permission.ask"]!(
    { type, pattern, id: "p1", sessionID: "s1", messageID: "m1", title: type, metadata: {}, time: { created: Date.now() } } as never,
    output,
  )
  return output
}

function sessionFile(): string {
  return path.join(worktree, ".opencode", "spec-memory", "session.json")
}

async function runBefore(tool: string, args: Record<string, unknown>): Promise<string | null> {
  const hooks = await guardPlugin.server({ worktree } as never)
  try {
    await hooks["tool.execute.before"]!(
      { tool, sessionID: "s1", callID: "c1" } as never,
      { args } as never,
    )
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function writeFeatureSpecJson(planApproved: boolean): Promise<string> {
  const featureDir = path.join(worktree, "specs", "001-test")
  await fs.mkdir(featureDir, { recursive: true })
  await fs.writeFile(path.join(featureDir, "plan.md"), "# Plan\n", "utf-8")
  const spec = {
    feature_name: "test",
    feature_number: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase: "plan",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: planApproved },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
  }
  await fs.writeFile(path.join(featureDir, "spec.json"), JSON.stringify(spec), "utf-8")
  return featureDir
}

describe("guard case sensitivity and normalization", () => {
  // The case-insensitive scenarios below need a case-insensitive filesystem,
  // so they are skipped on Linux where paths are always case-sensitive.
  it.skipIf(process.platform === "linux")("matches protected files case-insensitively", () => {
    const reason = isProtectedFile(path.join(worktree, ".opencode", "spec-memory", "SESSION.JSON"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
    expect(reason).toContain("session.json")
  })

  it("matches protected files with mixed separators", () => {
    const reason = isProtectedFile(".opencode\\spec-memory\\session.json", DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
  })

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeGuardPath(".opencode\\spec-memory\\session.json")).toContain(".opencode/spec-memory/session.json")
  })

  it.skipIf(process.platform === "linux")("detects protectedAfterApproval case-insensitively", () => {
    const reason = isProtectedAfterApproval(path.join(worktree, "specs", "001-a", "PLAN.MD"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
  })

  it.skipIf(process.platform === "linux")("detects phase protection case-insensitively", () => {
    const reason = isProtectedByPhase(path.join(worktree, "specs", "001-a", "PLAN.MD"), "ready", DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
  })

  it.skipIf(process.platform === "linux")("denies edit with uppercase name via hook", async () => {
    await fs.writeFile(sessionFile(), "{}", "utf-8")
    const output = await runHook("edit", path.join(worktree, ".opencode", "spec-memory", "SESSION.JSON"))
    expect(output.status).toBe("deny")
  })
})

describe("guard fail-closed on unreadable spec.json", () => {
  it("denies protectedAfterApproval file when spec.json is missing", async () => {
    const featureDir = path.join(worktree, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "plan.md"), "# Plan\n", "utf-8")
    const output = await runHook("edit", path.join(featureDir, "plan.md"))
    expect(output.status).toBe("deny")
  })

  it("denies protectedAfterApproval file when spec.json is corrupt", async () => {
    const featureDir = path.join(worktree, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "spec.json"), "{corrupt", "utf-8")
    await fs.writeFile(path.join(featureDir, "tasks.md"), "# Tasks\n", "utf-8")
    const output = await runHook("edit", path.join(featureDir, "tasks.md"))
    expect(output.status).toBe("deny")
  })

  it("denies phase-listed file when spec.json is missing", async () => {
    const featureDir = path.join(worktree, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "tasks.md"), "# Tasks\n", "utf-8")
    const output = await runHook("edit", path.join(featureDir, "tasks.md"))
    expect(output.status).toBe("deny")
  })

  it("allows non-listed file when spec.json is missing", async () => {
    const featureDir = path.join(worktree, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "notes.md"), "# Notes\n", "utf-8")
    const output = await runHook("edit", path.join(featureDir, "notes.md"))
    expect(output.status).toBe("ask")
  })
})

describe("guard self protection", () => {
  it("protects guard.json itself", () => {
    const reason = isProtectedFile(path.join(worktree, ".opencode", "guard.json"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
    expect(reason).toContain("guard.json")
  })

  it("denies edit of guard.json via hook", async () => {
    const output = await runHook("edit", path.join(worktree, ".opencode", "guard.json"))
    expect(output.status).toBe("deny")
  })
})

describe("guard spec.json anti-forgery protection", () => {
  it("always protects spec.json of any feature by basename", () => {
    const reason = isProtectedFile(path.join(worktree, "specs", "001-test", "spec.json"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
    expect(reason).toContain("spec.json")
  })

  it("protects spec.json even when the feature file does not exist yet", () => {
    const reason = isProtectedFile(path.join(worktree, "specs", "002-other", "spec.json"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
  })

  it("denies edit of spec.json via hook", async () => {
    const output = await runHook("edit", path.join(worktree, "specs", "001-test", "spec.json"))
    expect(output.status).toBe("deny")
  })

  it("denies shell redirect to spec.json", async () => {
    const output = await runHook("bash", "echo forged > specs/001-test/spec.json")
    expect(output.status).toBe("deny")
  })

  it.skipIf(process.platform === "linux")("matches SPEC.JSON case-insensitively", () => {
    const reason = isProtectedFile(path.join(worktree, "specs", "001-test", "SPEC.JSON"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
  })

  it("still allows editing non-protected feature files", async () => {
    const output = await runHook("edit", path.join(worktree, "specs", "001-test", "notes.md"))
    expect(output.status).toBe("ask")
  })
})

describe("guard steering docs stay writable for /steering", () => {
  it("does not always-protect steering docs", () => {
    for (const name of ["product.md", "tech.md", "structure.md"]) {
      const reason = isProtectedFile(path.join(worktree, ".opencode", "steering", name), DEFAULT_CONFIG)
      expect(reason).toBeNull()
    }
  })

  it("allows editing steering docs via hook", async () => {
    await fs.mkdir(path.join(worktree, ".opencode", "steering"), { recursive: true })
    const output = await runHook("edit", path.join(worktree, ".opencode", "steering", "product.md"))
    expect(output.status).toBe("ask")
  })

  it("keeps the constitution always protected", () => {
    const reason = isProtectedFile(path.join(worktree, ".opencode", "spec-memory", "constitution.md"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
    expect(reason).toContain("Always protected")
  })

  it("keeps session.json and config.json always protected", () => {
    expect(isProtectedFile(path.join(worktree, ".opencode", "spec-memory", "session.json"), DEFAULT_CONFIG)).not.toBeNull()
    expect(isProtectedFile(path.join(worktree, ".opencode", "spec-memory", "config.json"), DEFAULT_CONFIG)).not.toBeNull()
  })
})

describe("guard constitution draft window", () => {
  const constitutionPath = (): string => path.join(worktree, ".opencode", "spec-memory", "constitution.md")

  it("allows editing the constitution while template placeholders remain", async () => {
    const draft = "# Project Constitution\n\n> Governing principles for [PROJECT NAME]\n\n- Simplicity: [add project-specific constraints]\n"
    await fs.writeFile(constitutionPath(), draft, "utf-8")
    expect(await runBefore("write", { filePath: constitutionPath() })).toBeNull()
    expect(await runBefore("edit", { filePath: constitutionPath() })).toBeNull()
  })

  it("blocks editing the constitution once placeholders are gone", async () => {
    await fs.writeFile(constitutionPath(), "# Project Constitution\n\nAll articles filled for this project.\n", "utf-8")
    const message = await runBefore("edit", { filePath: constitutionPath() })
    expect(message).not.toBeNull()
    expect(message).toContain("Guard blocked")
  })

  it("stays protected when the constitution file is unreadable", async () => {
    const message = await runBefore("write", { filePath: constitutionPath() })
    expect(message).not.toBeNull()
    expect(message).toContain("Guard blocked")
  })

  it("keeps reporting the constitution as always protected", () => {
    const reason = isProtectedFile(path.join(worktree, ".opencode", "spec-memory", "constitution.md"), DEFAULT_CONFIG)
    expect(reason).not.toBeNull()
    expect(reason).toContain("Always protected")
  })
})

describe("guard config schema robustness", () => {
  it("falls back to defaults for invalid types", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), JSON.stringify({ enabled: "yes" }), "utf-8")
    const result = await guardTool.execute({ subcommand: "status" }, ctx)
    expect(result.title).toBe("Guard Status")
    expect(result.output).toContain("ENABLED")
  })

  it("merges partial config with defaults", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), JSON.stringify({ enabled: false }), "utf-8")
    const result = await guardTool.execute({ subcommand: "status" }, ctx)
    expect(result.output).toContain("DISABLED")
    expect(result.output).toContain("constitution.md")
  })

  it("writes schema-valid config when toggling debug", async () => {
    await guardTool.execute({ subcommand: "debug", debugOption: "on" }, ctx)
    const raw = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "guard.json"), "utf-8"))
    expect(GuardConfigSchema.safeParse(raw).success).toBe(true)
    expect(raw.debug).toBe(true)
  })

  it("survives garbage JSON in guard.json", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), "not json", "utf-8")
    const result = await guardTool.execute({ subcommand: "status" }, ctx)
    expect(result.title).toBe("Guard Status")
  })
})

describe("guard artifact name scoping outside specs/", () => {
  it("allows editing an agent definition named spec.md outside specs/", async () => {
    const dir = path.join(worktree, "agents")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "spec.md"), "---\nmode: primary\n---\n", "utf-8")
    expect(await runBefore("edit", { filePath: path.join(dir, "spec.md") })).toBeNull()
  })

  it("allows editing command docs named plan.md and tasks.md outside specs/", async () => {
    const dir = path.join(worktree, "commands")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "plan.md"), "# Command\n", "utf-8")
    await fs.writeFile(path.join(dir, "tasks.md"), "# Command\n", "utf-8")
    expect(await runBefore("write", { filePath: path.join(dir, "plan.md") })).toBeNull()
    expect(await runBefore("write", { filePath: path.join(dir, "tasks.md") })).toBeNull()
  })

  it("still denies spec.md inside a feature dir when spec.json is missing", async () => {
    const featureDir = path.join(worktree, "specs", "001-test")
    await fs.mkdir(featureDir, { recursive: true })
    await fs.writeFile(path.join(featureDir, "spec.md"), "# Spec\n", "utf-8")
    const message = await runBefore("edit", { filePath: path.join(featureDir, "spec.md") })
    expect(message).not.toBeNull()
    expect(message).toContain("Guard blocked")
  })

  it("does not treat a directory named myspecs as a feature dir", () => {
    expect(isInFeatureDir(path.join(worktree, "myspecs", "001-a", "spec.md"))).toBe(false)
  })

  it("detects feature dirs at any depth", () => {
    expect(isInFeatureDir(path.join(worktree, "specs", "001-a", "spec.md"))).toBe(true)
    expect(isInFeatureDir("C:/specs/001-a/spec.md")).toBe(true)
    expect(isInFeatureDir(path.join(worktree, "agents", "spec.md"))).toBe(false)
  })
})

describe("guard shell redirect interception", () => {
  it("extracts redirect targets", () => {
    expect(extractRedirectTargets("echo hi > out.txt")).toEqual(["out.txt"])
    expect(extractRedirectTargets("echo hi >> log.txt")).toEqual(["log.txt"])
    expect(extractRedirectTargets('echo hi > "quoted file.md"')).toEqual(["quoted file.md"])
    expect(extractRedirectTargets("echo hi | tee notes.md")).toEqual(["notes.md"])
    expect(extractRedirectTargets("echo hi | tee -a notes.md")).toEqual(["notes.md"])
  })

  it("ignores stderr merges and here-docs", () => {
    expect(extractRedirectTargets("cmd 2>&1")).toEqual([])
    expect(extractRedirectTargets("cmd <<EOF")).toEqual([])
    expect(extractRedirectTargets("git status")).toEqual([])
  })

  it("denies bash redirect to a protected file", async () => {
    await fs.writeFile(sessionFile(), "{}", "utf-8")
    const output = await runHook("bash", "echo attacked > .opencode/spec-memory/session.json")
    expect(output.status).toBe("deny")
  })

  it("denies bash append redirect to a protected file", async () => {
    const output = await runHook("bash", "echo attacked >> .opencode/spec-memory/config.json")
    expect(output.status).toBe("deny")
  })

  it("denies tee into a protected file", async () => {
    const output = await runHook("bash", "echo attacked | tee .opencode/guard.json")
    expect(output.status).toBe("deny")
  })

  it("allows bash redirect to an unprotected file", async () => {
    const output = await runHook("bash", "echo ok > notes.txt")
    expect(output.status).toBe("ask")
  })

  it("allows harmless bash commands", async () => {
    const output = await runHook("bash", "git status && npm test")
    expect(output.status).toBe("ask")
  })

  it("increments denied stats on shell denial", async () => {
    await runHook("bash", "echo x > .opencode/spec-memory/session.json")
    const raw = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "guard.json"), "utf-8"))
    expect(raw.stats.denied).toBeGreaterThanOrEqual(1)
    expect(raw.denials.length).toBeGreaterThanOrEqual(1)
  })
})

describe("guard tool.execute.before enforcement", () => {
  it("blocks write to spec.json even when permissions allow", async () => {
    const message = await runBefore("write", { filePath: path.join(worktree, "specs", "001-test", "spec.json") })
    expect(message).not.toBeNull()
    expect(message).toContain("Guard blocked")
    expect(message).toContain("spec.json")
  })

  it("blocks apply_patch and edit to protected state files", async () => {
    expect(await runBefore("apply_patch", { filePath: sessionFile() })).toContain("Guard blocked")
    expect(await runBefore("edit", { filePath: path.join(worktree, ".opencode", "guard.json") })).toContain("Guard blocked")
  })

  it("blocks editing an approved plan.md", async () => {
    const featureDir = await writeFeatureSpecJson(true)
    const message = await runBefore("write", { filePath: path.join(featureDir, "plan.md") })
    expect(message).not.toBeNull()
    expect(message).toContain("approved")
  })

  it("allows editing a plan.md that is not approved yet", async () => {
    const featureDir = await writeFeatureSpecJson(false)
    expect(await runBefore("write", { filePath: path.join(featureDir, "plan.md") })).toBeNull()
  })

  it("blocks bash redirects to protected files", async () => {
    const message = await runBefore("bash", { command: "echo forged > .opencode/spec-memory/session.json" })
    expect(message).not.toBeNull()
    expect(message).toContain("Guard blocked")
  })

  it("allows writes to unprotected files", async () => {
    expect(await runBefore("write", { filePath: path.join(worktree, "specs", "001-test", "notes.md") })).toBeNull()
  })

  it("allows everything when the guard is disabled", async () => {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(worktree, ".opencode", "guard.json"), JSON.stringify({ ...DEFAULT_CONFIG, enabled: false }), "utf-8")
    expect(await runBefore("write", { filePath: sessionFile() })).toBeNull()
  })

  it("records the blocked denial in guard.json", async () => {
    await runBefore("write", { filePath: sessionFile() })
    const raw = JSON.parse(await fs.readFile(path.join(worktree, ".opencode", "guard.json"), "utf-8"))
    expect(raw.stats.denied).toBeGreaterThanOrEqual(1)
    expect(raw.denials.some((d: { file: string }) => d.file.includes("session.json"))).toBe(true)
  })

  it.skipIf(process.platform === "linux")("blocks uppercase protected paths", async () => {
    const message = await runBefore("write", { filePath: path.join(worktree, ".opencode", "spec-memory", "SESSION.JSON") })
    expect(message).toContain("Guard blocked")
  })
})
