import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { collectScope, snapshotsDirPath } from "../../shared/snapshot/paths"
import { createSnapshot, listSnapshots, readSnapshotManifest, verifySnapshot } from "../../shared/snapshot/manifest"
import { SnapshotManifestSchema } from "../../shared/schemas"

let worktree: string

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(worktree, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

beforeEach(async () => {
  worktree = await createTempWorktree()
  await write(
    ".opencode/spec-memory/session.json",
    JSON.stringify({
      command: null,
      phase: "init",
      featureDir: null,
      featureNumber: null,
      featureName: null,
      nextStep: "/spec <description>",
      lastResult: null,
      history: [],
    }),
  )
  await write(
    ".opencode/spec-memory/config.json",
    JSON.stringify({
      defaultTechStack: null,
      lastUsedLanguage: null,
      expressMode: false,
      autoVersioning: false,
      preferences: {},
    }),
  )
  await write(".opencode/spec-memory/constitution.md", "# Constitution\n")
  await write(".opencode/guard.json", JSON.stringify({ version: 1, enabled: true }))
  await write(".opencode/steering/product.md", "# Product\n")
  await write(".opencode/steering/tech.md", "# Tech\n")
  await write(".opencode/domain-map.md", "# Domain\n")
  await write("specs/001-demo/spec.md", "# Spec\n")
  await write("specs/001-demo/spec.json", "{}")
  await write("specs/001-demo/plan.md", "# Plan\n")
  await write(".opencode/backups/old.bak", "old")
  await write(".opencode/spec-memory/session.json.sha256", "checksum")
  await write("specs/001-demo/plan.md.tmp", "tmp")
  await write("specs/001-demo/notes.lock", "lock")
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("SnapshotManifestSchema", () => {
  it("rejects invalid sha256, negative sizes, and accepts an empty file list", () => {
    const base = {
      format: 1,
      id: "x",
      created_at: new Date().toISOString(),
      trigger: "manual",
      feature: null,
      phase: null,
    }
    expect(SnapshotManifestSchema.safeParse({ ...base, files: [{ path: "a", size: -1, sha256: "a".repeat(64) }] }).success).toBe(false)
    expect(SnapshotManifestSchema.safeParse({ ...base, files: [{ path: "a", size: 1, sha256: "short" }] }).success).toBe(false)
    expect(SnapshotManifestSchema.safeParse({ ...base, files: [] }).success).toBe(true)
  })
})

describe("collectScope", () => {
  it("includes core, specs, steering, and domain map", async () => {
    const scope = await collectScope(worktree)
    expect(scope).toContain(".opencode/spec-memory/session.json")
    expect(scope).toContain(".opencode/spec-memory/config.json")
    expect(scope).toContain(".opencode/spec-memory/constitution.md")
    expect(scope).toContain(".opencode/guard.json")
    expect(scope).toContain(".opencode/steering/product.md")
    expect(scope).toContain(".opencode/steering/tech.md")
    expect(scope).toContain(".opencode/domain-map.md")
    expect(scope).toContain("specs/001-demo/spec.md")
    expect(scope).toContain("specs/001-demo/plan.md")
  })

  it("excludes backups, checksum sidecars, tmp, lock, and bak files", async () => {
    const scope = await collectScope(worktree)
    expect(scope.some((p) => p.startsWith(".opencode/backups"))).toBe(false)
    expect(scope.some((p) => p.endsWith(".sha256"))).toBe(false)
    expect(scope.some((p) => p.endsWith(".tmp"))).toBe(false)
    expect(scope.some((p) => p.endsWith(".lock"))).toBe(false)
    expect(scope.some((p) => p.endsWith(".bak"))).toBe(false)
  })
})

describe("createSnapshot", () => {
  it("creates a snapshot with a valid manifest covering the whole scope", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual", feature: "001-demo", phase: "plan" })
    expect(SnapshotManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.trigger).toBe("manual")
    expect(manifest.feature).toBe("001-demo")
    expect(manifest.phase).toBe("plan")

    const scope = await collectScope(worktree)
    expect(manifest.files.map((f) => f.path).sort()).toEqual([...scope].sort())
    expect(manifest.files.every((f) => !f.path.includes("\\"))).toBe(true)

    const snapshotDir = path.join(snapshotsDirPath(worktree), manifest.id)
    expect(await fs.stat(snapshotDir).then((s) => s.isDirectory())).toBe(true)
    const specCopy = await fs.readFile(path.join(snapshotDir, "specs", "001-demo", "spec.md"), "utf-8")
    expect(specCopy).toBe("# Spec\n")
  })

  it("records correct size and sha256 for a known file", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const entry = manifest.files.find((f) => f.path === ".opencode/steering/product.md")
    expect(entry).toBeDefined()
    const content = Buffer.from("# Product\n", "utf-8")
    expect(entry?.size).toBe(content.byteLength)
    expect(entry?.sha256).toBe(crypto.createHash("sha256").update(content).digest("hex"))
  })

  it("succeeds with only the core files that exist", async () => {
    const bare = await createTempWorktree()
    try {
      await fs.writeFile(path.join(bare, ".opencode", "spec-memory", "constitution.md"), "# C\n")
      const manifest = await createSnapshot(bare, { trigger: "manual" })
      expect(manifest.files.map((f) => f.path)).toEqual([".opencode/spec-memory/constitution.md"])
    } finally {
      await destroyTempWorktree(bare)
    }
  })

  it("creates unique ids for snapshots taken at the same instant", async () => {
    const now = new Date(2026, 0, 2, 3, 4, 5)
    const first = await createSnapshot(worktree, { trigger: "manual", now })
    const second = await createSnapshot(worktree, { trigger: "manual", now })
    expect(first.id).not.toBe(second.id)
    expect(second.id.endsWith("-2")).toBe(true)
  })

  it("removes the partial snapshot and throws when a file cannot be read", async () => {
    const original = fs.readFile as unknown as (...args: unknown[]) => Promise<unknown>
    const spy = vi.spyOn(fs, "readFile").mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).endsWith("constitution.md")) {
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
      }
      return original(...args)
    }) as never)

    await expect(createSnapshot(worktree, { trigger: "manual" })).rejects.toThrow()
    spy.mockRestore()

    const entries = await fs.readdir(snapshotsDirPath(worktree)).catch(() => [] as string[])
    expect(entries).toEqual([])
  })
})

describe("verifySnapshot", () => {
  it("reports ok for an intact snapshot", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const result = await verifySnapshot(worktree, manifest.id)
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.entries.every((e) => e.status === "ok")).toBe(true)
  })

  it("detects a single-byte modification as a mismatch", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.appendFile(path.join(snapshotsDirPath(worktree), manifest.id, "specs", "001-demo", "spec.md"), "x")
    const result = await verifySnapshot(worktree, manifest.id)
    expect(result.ok).toBe(false)
    expect(result.entries.find((e) => e.path === "specs/001-demo/spec.md")?.status).toBe("mismatch")
  })

  it("detects a missing file", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.rm(path.join(snapshotsDirPath(worktree), manifest.id, ".opencode", "steering", "product.md"))
    const result = await verifySnapshot(worktree, manifest.id)
    expect(result.ok).toBe(false)
    expect(result.entries.find((e) => e.path === ".opencode/steering/product.md")?.status).toBe("missing")
  })

  it("reports unreadable for a corrupt or missing manifest", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.writeFile(path.join(snapshotsDirPath(worktree), manifest.id, "manifest.json"), "not json", "utf-8")
    const result = await verifySnapshot(worktree, manifest.id)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("manifest unreadable")
    expect(result.manifest).toBeNull()
  })
})

describe("readSnapshotManifest", () => {
  it("returns the parsed manifest and null for a missing snapshot", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    const read = await readSnapshotManifest(worktree, manifest.id)
    expect(read?.id).toBe(manifest.id)
    expect(await readSnapshotManifest(worktree, "does-not-exist")).toBeNull()
  })
})

describe("listSnapshots", () => {
  it("returns an empty list when there are no snapshots", async () => {
    expect(await listSnapshots(worktree)).toEqual([])
  })

  it("lists newest first with verification status and totals", async () => {
    const older = await createSnapshot(worktree, { trigger: "manual", now: new Date(2026, 0, 1, 10, 0, 0) })
    const newer = await createSnapshot(worktree, { trigger: "pre-fix-audit", now: new Date(2026, 0, 2, 10, 0, 0) })
    const list = await listSnapshots(worktree)
    expect(list.map((e) => e.id)).toEqual([newer.id, older.id])
    expect(list.every((e) => e.status === "verified")).toBe(true)
    expect(list[0]?.trigger).toBe("pre-fix-audit")
    expect(list[0]?.fileCount).toBeGreaterThan(0)
    expect(list[0]?.totalSize).toBeGreaterThan(0)
  })

  it("marks a tampered snapshot as mismatched and a manifestless dir as unreadable", async () => {
    const manifest = await createSnapshot(worktree, { trigger: "manual" })
    await fs.appendFile(path.join(snapshotsDirPath(worktree), manifest.id, ".opencode", "guard.json"), " ")
    await fs.mkdir(path.join(snapshotsDirPath(worktree), "20990101-000000-ghost"), { recursive: true })

    const list = await listSnapshots(worktree)
    expect(list.find((e) => e.id === manifest.id)?.status).toBe("mismatched")
    expect(list.find((e) => e.id === "20990101-000000-ghost")?.status).toBe("unreadable")
  })
})
