import { describe, it, expect } from "vitest"
import {
  SnapshotManifestSchema,
  RestoreJournalSchema,
  SnapshotPinSchema,
  SnapshotDrillSchema,
} from "../../shared/schemas"
import { GuardConfigSchema, DEFAULT_CONFIG } from "../../plugins/speckit-guard"

function validManifest() {
  return {
    format: 1 as const,
    id: "20260304-050607-manual",
    created_at: "2026-03-04T05:06:07.000Z",
    trigger: "manual",
    feature: null,
    phase: null,
    files: [{ path: ".opencode/spec-memory/session.json", size: 42, sha256: "a".repeat(64) }],
  }
}

function validJournal() {
  return {
    format: 1 as const,
    snapshot_id: "20260304-050607-manual",
    safety_snapshot_id: "20260304-050608-pre-restore-x",
    mode: "full" as const,
    started_at: "2026-03-04T05:06:08.000Z",
    files: [],
    removed: [],
  }
}

function validPin() {
  return { pinned_at: "2026-03-04T05:06:07.000Z", label: null }
}

function validDrill() {
  return { drilled_at: "2026-03-04T05:06:07.000Z", ok: true, files_checked: 3, error: null }
}

type Case = [label: string, value: unknown, accepted: boolean]

const STRING_ACCEPTED: Case[] = [
  ["plain string", "value", true],
  ["empty string", "", true],
  ["unicode string", "日本語", true],
  ["newline in string", "a\nb", true],
  ["null byte in string", "a\u0000b", true],
  ["prototype pollution key", "__proto__", true],
  ["long string", "x".repeat(10_000), true],
  ["null", null, false],
  ["undefined", undefined, false],
  ["number", 1, false],
  ["boolean", true, false],
  ["array", [], false],
  ["object", {}, false],
]

describe("Fuzz: SnapshotManifestSchema", () => {
  it("accepts a valid manifest and an empty file list", () => {
    expect(SnapshotManifestSchema.safeParse(validManifest()).success).toBe(true)
    expect(SnapshotManifestSchema.safeParse({ ...validManifest(), files: [] }).success).toBe(true)
  })

  it.each([
    ["format 1", 1, true],
    ["format 2", 2, false],
    ["format string", "1", false],
    ["format null", null, false],
    ["format float", 1.5, false],
  ] as Case[])("format %s -> %s", async (_label, value, accepted) => {
    const result = SnapshotManifestSchema.safeParse({ ...validManifest(), format: value })
    expect(result.success).toBe(accepted)
  })

  it.each(STRING_ACCEPTED.filter(([label]) => label !== "empty string"))("id: %s -> %s", async (_label, value, accepted) => {
    const result = SnapshotManifestSchema.safeParse({ ...validManifest(), id: value })
    expect(result.success).toBe(accepted)
  })

  it("id rejects the empty string (min length)", () => {
    expect(SnapshotManifestSchema.safeParse({ ...validManifest(), id: "" }).success).toBe(false)
  })

  it.each(STRING_ACCEPTED.filter(([label]) => label !== "empty string"))("trigger: %s -> %s", async (_label, value, accepted) => {
    const result = SnapshotManifestSchema.safeParse({ ...validManifest(), trigger: value })
    expect(result.success).toBe(accepted)
  })

  it("trigger rejects the empty string (min length)", () => {
    expect(SnapshotManifestSchema.safeParse({ ...validManifest(), trigger: "" }).success).toBe(false)
  })

  it.each([
    ["null", null, true],
    ["string", "001-demo", true],
    ["empty string", "", true],
    ["number", 1, false],
    ["boolean", false, false],
    ["array", [], false],
    ["object", {}, false],
  ] as Case[])("nullable feature/phase: %s -> %s", async (_label, value, accepted) => {
    const result = SnapshotManifestSchema.safeParse({ ...validManifest(), feature: value, phase: value })
    expect(result.success).toBe(accepted)
  })

  it.each([
    ["empty array", [], true],
    ["valid entry", [{ path: "a", size: 0, sha256: "a".repeat(64) }], true],
    ["unicode path", [{ path: "specs/ñ/spec.md", size: 1, sha256: "b".repeat(64) }], true],
    ["entry without sha256", [{ path: "a", size: 1 }], false],
    ["entry with negative size", [{ path: "a", size: -1, sha256: "a".repeat(64) }], false],
    ["entry with float size", [{ path: "a", size: 1.5, sha256: "a".repeat(64) }], false],
    ["entry with empty path", [{ path: "", size: 0, sha256: "a".repeat(64) }], false],
    ["entry with numeric path", [{ path: 1, size: 0, sha256: "a".repeat(64) }], false],
    ["null entry", [null], false],
    ["string instead of array", "files", false],
    ["object instead of array", {}, false],
  ] as Case[])("files: %s -> %s", async (_label, value, accepted) => {
    const result = SnapshotManifestSchema.safeParse({ ...validManifest(), files: value })
    expect(result.success).toBe(accepted)
  })
})

describe("Fuzz: RestoreJournalSchema", () => {
  it.each([
    ["full", true],
    ["selective", true],
    ["partial", false],
    ["FULL", false],
    ["null", false],
    ["number", false],
  ] as Array<[unknown, boolean]>)("mode %j -> %s", async (mode, accepted) => {
    const result = RestoreJournalSchema.safeParse({ ...validJournal(), mode })
    expect(result.success).toBe(accepted)
  })

  it("selective mode is schema-valid with and without file lists", () => {
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), mode: "selective", files: ["a"] }).success).toBe(true)
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), mode: "selective", files: [] }).success).toBe(true)
  })

  it.each(STRING_ACCEPTED.filter(([label]) => label !== "empty string"))(
    "snapshot_id: %s -> %s",
    async (_label, value, accepted) => {
      expect(RestoreJournalSchema.safeParse({ ...validJournal(), snapshot_id: value }).success).toBe(accepted)
    },
  )

  it("snapshot_id rejects the empty string", () => {
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), snapshot_id: "" }).success).toBe(false)
  })

  it.each([
    ["empty array", [], true],
    ["paths", ["specs/001-a/spec.md"], true],
    ["traversal-looking path", ["../escape"], true],
    ["numeric entry", [42], false],
    ["object entry", [{}], false],
    ["null entry", [null], false],
    ["string instead of array", "a", false],
  ] as Case[])("files: %s -> %s", async (_label, value, accepted) => {
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), files: value }).success).toBe(accepted)
  })

  it("removed accepts the same shapes as files", () => {
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), removed: ["a"] }).success).toBe(true)
    expect(RestoreJournalSchema.safeParse({ ...validJournal(), removed: [1] }).success).toBe(false)
  })
})

describe("Fuzz: SnapshotPinSchema", () => {
  it.each(STRING_ACCEPTED)("pinned_at: %s -> %s", async (_label, value, accepted) => {
    expect(SnapshotPinSchema.safeParse({ ...validPin(), pinned_at: value }).success).toBe(accepted)
  })

  it.each([
    ["null label", null, true],
    ["plain label", "golden", true],
    ["empty label", "", true],
    ["unicode label", "estado-ñ-✓", true],
    ["very long label", "l".repeat(5000), true],
    ["number label", 1, false],
    ["array label", [], false],
    ["object label", {}, false],
  ] as Case[])("label: %s -> %s", async (_label, value, accepted) => {
    expect(SnapshotPinSchema.safeParse({ ...validPin(), label: value }).success).toBe(accepted)
  })
})

describe("Fuzz: SnapshotDrillSchema", () => {
  it.each([
    ["ok true", true, true],
    ["ok false", false, true],
    ["ok string", "true", false],
    ["ok null", null, false],
    ["ok number", 1, false],
  ] as Array<[string, unknown, boolean]>)("ok %s -> %s", async (_label, value, accepted) => {
    expect(SnapshotDrillSchema.safeParse({ ...validDrill(), ok: value }).success).toBe(accepted)
  })

  it.each([
    ["zero", 0, true],
    ["positive int", 12, true],
    ["max safe int", Number.MAX_SAFE_INTEGER, true],
    ["negative", -1, false],
    ["float", 1.5, false],
    ["numeric string", "3", false],
    ["null", null, false],
    ["nan", Number.NaN, false],
  ] as Array<[string, unknown, boolean]>)("files_checked %s -> %s", async (_label, value, accepted) => {
    expect(SnapshotDrillSchema.safeParse({ ...validDrill(), files_checked: value }).success).toBe(accepted)
  })

  it.each([
    ["null error", null, true],
    ["empty error", "", true],
    ["message", "checksum mismatch", true],
    ["numeric error", 42, false],
    ["object error", {}, false],
  ] as Case[])("error: %s -> %s", async (_label, value, accepted) => {
    expect(SnapshotDrillSchema.safeParse({ ...validDrill(), error: value }).success).toBe(accepted)
  })
})

describe("Fuzz: GuardConfigSchema", () => {
  it("accepts the default configuration", () => {
    expect(GuardConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })

  it.each([
    ["number version", { version: 1 }, true],
    ["string version", { version: "1" }, false],
    ["null version", { version: null }, false],
    ["boolean enabled", { enabled: false }, true],
    ["string enabled", { enabled: "yes" }, false],
    ["array of strings", { protectedFiles: ["a", "b"] }, true],
    ["empty array", { protectedFiles: [] }, true],
    ["numeric entry", { protectedFiles: [1] }, false],
    ["string instead of array", { protectedFiles: "spec.json" }, false],
    ["phase map", { protectedByPhase: { tasks: ["plan.md"] } }, true],
    ["phase map with numeric entry", { protectedByPhase: { tasks: [2] } }, false],
    ["phase map as array", { protectedByPhase: ["tasks"] }, false],
    ["numeric stats", { stats: { denied: 0, allowed: 0, asked: 0 } }, true],
    ["string stat", { stats: { denied: "many", allowed: 0, asked: 0 } }, false],
    ["missing stat", { stats: { denied: 0, allowed: 0 } }, false],
    ["denials array", { denials: [{ timestamp: "t", file: "f", reason: "r" }] }, true],
    ["denial without reason", { denials: [{ timestamp: "t", file: "f" }] }, false],
    ["denials as string", { denials: "none" }, false],
  ] as Array<[string, Record<string, unknown>, boolean]>)("%s -> %s", async (_label, overrides, accepted) => {
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...overrides }).success).toBe(accepted)
  })

  it.each([
    ["boolean", true, true],
    ["string", "true", false],
    ["null", null, false],
    ["number", 0, false],
  ] as Array<[string, unknown, boolean]>)("debug flag %s -> %s", async (_label, value, accepted) => {
    expect(GuardConfigSchema.safeParse({ ...DEFAULT_CONFIG, debug: value }).success).toBe(accepted)
  })

  it("strips unknown keys instead of failing", () => {
    const parsed = GuardConfigSchema.parse({ ...DEFAULT_CONFIG, injected: "value" } as never)
    expect("injected" in parsed).toBe(false)
    const parsedStats = GuardConfigSchema.parse({
      ...DEFAULT_CONFIG,
      stats: { ...DEFAULT_CONFIG.stats, extra: 1 },
    } as never)
    expect("extra" in parsedStats.stats).toBe(false)
  })
})