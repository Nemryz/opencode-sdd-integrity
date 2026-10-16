import { describe, it, expect } from "vitest"
import {
  DEFAULT_CONFIG,
  extractRedirectTargets,
  guardBasename,
  isApprovedForFile,
  isDraftConstitution,
  isInFeatureDir,
  isProtectedAfterApproval,
  isProtectedByPhase,
  isProtectedFile,
  normalizeGuardPath,
} from "../../plugins/speckit-guard"
import type { SpecJson } from "../../shared/types"

function specWith(approvals: Partial<Record<"spec" | "plan" | "tasks", boolean>>): SpecJson {
  return {
    feature_name: "demo",
    feature_number: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    phase: "ready",
    approvals: {
      spec: { generated: true, approved: approvals.spec ?? false },
      plan: { generated: true, approved: approvals.plan ?? false },
      tasks: { generated: true, approved: approvals.tasks ?? false },
    },
    ready_for_implementation: true,
  }
}

describe("matrix: normalizeGuardPath", () => {
  it.each([
    ["forward slashes kept", "specs/001-a/spec.json", "specs/001-a/spec.json"],
    ["backslashes unified", "specs\\001-a\\spec.json", "specs/001-a/spec.json"],
    ["mixed separators", "specs/001-a\\plan.md", "specs/001-a/plan.md"],
  ])("%s -> %s", (_label, input, expectedUncased) => {
    const normalized = normalizeGuardPath(input as string)
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
    expect(normalized).toBe(caseInsensitive ? (expectedUncased as string).toLowerCase() : expectedUncased)
  })
})

describe("matrix: guardBasename", () => {
  it.each([
    ["nested posix", "specs/001-a/spec.json", "spec.json"],
    ["nested windows", "specs\\001-a\\plan.md", "plan.md"],
    ["bare name", "constitution.md", "constitution.md"],
    ["absolute posix", "/home/dev/project/spec.json", "spec.json"],
    ["trailing slash is not a name", "specs/001-a/", ""],
    ["empty", "", ""],
  ])("%s -> %s", (_label, input, expected) => {
    expect(guardBasename(input as string)).toBe(expected)
  })
})

describe("matrix: isProtectedFile", () => {
  it.each([
    ["constitution", ".opencode/spec-memory/constitution.md", true],
    ["session", ".opencode/spec-memory/session.json", true],
    ["config", ".opencode/spec-memory/config.json", true],
    ["guard config", ".opencode/guard.json", true],
    ["feature spec.json", "specs/001-a/spec.json", true],
    ["absolute constitution", "C:/dev/app/.opencode/spec-memory/constitution.md", true],
    ["windows feature spec", "specs\\001-a\\spec.json", true],
    ["unrelated source file", "src/index.ts", false],
    ["spec.md is not always-protected", "specs/001-a/spec.md", false],
    ["directory-looking path", "specs/001-a", false],
  ])("%s -> %s", (_label, filePath, expected) => {
    expect(isProtectedFile(filePath as string, DEFAULT_CONFIG) !== null).toBe(expected)
  })
})

describe("matrix: isProtectedAfterApproval", () => {
  it.each([
    ["spec.md", "specs/001-a/spec.md", true],
    ["plan.md", "specs/001-b/plan.md", true],
    ["tasks.md", "specs/001-b/tasks.md", true],
    ["spec.json", "specs/001-b/spec.json", true],
    ["research.md is not protected", "specs/001-b/research.md", false],
    ["outside a feature", "README.md", false],
  ])("%s -> %s", (_label, filePath, expected) => {
    expect(isProtectedAfterApproval(filePath as string, DEFAULT_CONFIG) !== null).toBe(expected)
  })
})

describe("matrix: isApprovedForFile", () => {
  it.each([
    ["spec.md approved", "spec.md", { spec: true }, true],
    ["spec.md not approved", "spec.md", { spec: false }, false],
    ["plan.md approved", "plan.md", { plan: true }, true],
    ["tasks.md approved", "tasks.md", { tasks: true }, true],
    ["spec.json approved", "spec.json", { spec: true }, true],
    ["spec.json not approved", "spec.json", {}, false],
    ["unknown artifact", "research.md", { spec: true, plan: true, tasks: true }, false],
    ["path instead of basename", "specs/001-a/spec.md", { spec: true }, false],
  ])("%s -> %s", (_label, base, approvals, expected) => {
    expect(isApprovedForFile(base as string, specWith(approvals as Record<string, boolean>))).toBe(expected)
  })
})

describe("matrix: isProtectedByPhase", () => {
  it.each([
    ["tasks phase blocks plan.md", "tasks", "specs/001-a/plan.md", true],
    ["ready phase blocks tasks.md", "ready", "specs/001-a/tasks.md", true],
    ["impl phase blocks plan.md", "impl", "specs/001-a/plan.md", true],
    ["complete phase blocks spec.md", "complete", "specs/001-a/spec.md", true],
    ["complete phase blocks spec.json", "complete", "specs/001-a/spec.json", true],
    ["spec phase has no extra protection", "spec", "specs/001-a/plan.md", false],
    ["unknown phase", "unknown", "specs/001-a/plan.md", false],
  ])("%s -> %s", (_label, phase, filePath, expected) => {
    expect(isProtectedByPhase(filePath as string, phase as string, DEFAULT_CONFIG) !== null).toBe(expected)
  })
})

describe("matrix: isInFeatureDir", () => {
  it.each([
    ["spec.json inside specs", "specs/001-a/spec.json", true],
    ["windows separators inside specs", "specs\\001-a\\spec.json", true],
    ["same filename outside specs", ".opencode/spec-memory/spec.json", false],
    // Known limitation: the matcher is segment-based, so any nested `specs/` segment matches.
    ["nested source dir named specs also matches", "src/specs/spec.json", true],
  ])("%s -> %s", (_label, filePath, expected) => {
    expect(isInFeatureDir(filePath as string)).toBe(expected)
  })
})

describe("matrix: isDraftConstitution", () => {
  it.each([
    ["project name placeholder", "# [PROJECT NAME]\nPrinciples", true],
    ["filled constitution", "# My Project Constitution\nAlways test first.", false],
    ["empty content", "", false],
    ["placeholder in the middle", "text [PROJECT NAME] more text", true],
    // Constitution draft state only tracks [PROJECT NAME]; [FEATURE NAME] belongs to artifact templates.
    ["feature name placeholder is not a draft marker", "# [FEATURE NAME]", false],
  ])("%s -> %s", (_label, content, expected) => {
    expect(isDraftConstitution(content as string)).toBe(expected)
  })
})

describe("matrix: extractRedirectTargets", () => {
  it.each([
    ["single redirect", "echo x > session.json", ["session.json"]],
    ["double redirect", "echo x >> session.json", ["session.json"]],
    ["quoted target", 'echo x > "my file.json"', ["my file.json"]],
    ["single-quoted target", "echo x > 'spec.json'", ["spec.json"]],
    ["multiple redirects", "a > one.json && b > two.json", ["one.json", "two.json"]],
    ["tee without append", "echo x | tee out.log", ["out.log"]],
    ["tee with append", "echo x | tee -a out.log", ["out.log"]],
    ["redirect to protected path", 'cat a > .opencode/spec-memory/session.json', [".opencode/spec-memory/session.json"]],
    ["no redirect", "echo hello", []],
    // Conservative: quoted text containing `>` still yields a candidate target.
    ["redirect-looking string in quotes", 'echo "a > b"', ["b"]],
  ])("%s -> %j", (_label, command, expected) => {
    expect(extractRedirectTargets(command as string)).toEqual(expected)
  })
})