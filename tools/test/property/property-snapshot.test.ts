import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import fs from "node:fs/promises"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { createSnapshot, listSnapshots, verifySnapshot } from "../../shared/snapshot/manifest"
import { restoreSnapshot } from "../../shared/snapshot/restore"
import { AUTO_CAP_PER_FEATURE, TOTAL_CAP, pinSnapshot, pruneSnapshots } from "../../shared/snapshot/retention"
import { snapshotBeforeOperation } from "../../shared/snapshot/triggers"
import { projectPath, writeProjectFile } from "../helpers/assertions"

// Runs one property case against its own worktree so cases never inherit state from the previous run.
async function withFreshWorktree(run: (worktree: string) => Promise<void>): Promise<void> {
  const dir = await createTempWorktree()
  try {
    await run(dir)
  } finally {
    await destroyTempWorktree(dir)
  }
}

// Generates file content that differs from case to case so hashes never repeat.
const contentArbitrary = fc.string({ minLength: 1, maxLength: 120 })

// Generates one file name from the artifacts that live inside the captured scope.
const fileNameArbitrary = fc.constantFrom(
  "specs/001-demo/spec.md",
  "specs/001-demo/plan.md",
  "specs/001-demo/tasks.md",
  "specs/002-other/spec.md",
  ".opencode/spec-memory/session.json",
  ".opencode/spec-memory/config.json",
  ".opencode/steering/product.md",
)

// Generates a fresh artifact name that every filesystem accepts on every platform.
const safeNameArbitrary = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), { minLength: 1, maxLength: 20 })
  .map(chars => chars.join(""))

// Generates one captured file where the name pairs with its own content.
const fileEntryArbitrary = fc.tuple(fileNameArbitrary, contentArbitrary)

// Generates triggers that span every retention priority the prune order understands.
const triggerArbitrary = fc.constantFrom("manual", "phase:ready->impl", "pre-restore:x", "pre-fix:audit")

// Builds timestamps that increase by one second so snapshot ids keep a stable creation order.
function sequenceTimes(count: number): Date[] {
  const base = new Date(2026, 0, 1, 0, 0, 0).getTime()
  return Array.from({ length: count }, (_unused, index) => new Date(base + index * 1000))
}

describe("property: snapshot round trip", () => {
  it("restores every captured file to the exact bytes of the snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fileEntryArbitrary, {
          selector: entry => entry[0],
          minLength: 1,
          maxLength: 6,
        }),
        contentArbitrary,
        async (files, laterContent) => {
          await withFreshWorktree(async (worktree) => {
            for (const [name, content] of files) {
              await writeProjectFile(worktree, name, content)
            }

            const manifest = await createSnapshot(worktree, { trigger: "manual" })
            expect((await verifySnapshot(worktree, manifest.id)).ok).toBe(true)

            // Every captured file changes before the restore so a no-op restore cannot pass.
            for (const [name] of files) {
              await writeProjectFile(worktree, name, laterContent)
            }

            await restoreSnapshot(worktree, manifest.id, { confirmed: true })

            for (const [name, content] of files) {
              expect(await fs.readFile(projectPath(worktree, name), "utf-8")).toBe(content)
            }
          })
        },
      ),
      { numRuns: 12 },
    )
  }, 60_000)

  it("removes files created after the snapshot when restoring in full mode", async () => {
    await fc.assert(
      fc.asyncProperty(safeNameArbitrary, async (extraName) => {
        await withFreshWorktree(async (worktree) => {
          await writeProjectFile(worktree, "specs/001-demo/spec.md", "# Spec\n")
          const manifest = await createSnapshot(worktree, { trigger: "manual" })

          await writeProjectFile(worktree, `specs/001-demo/${extraName}.md`, "late\n")
          await restoreSnapshot(worktree, manifest.id, { confirmed: true })

          const stat = await fs.stat(projectPath(worktree, `specs/001-demo/${extraName}.md`)).catch(() => null)
          expect(stat).toBeNull()
        })
      }),
      { numRuns: 10 },
    )
  }, 60_000)
})

describe("property: trigger reuse", () => {
  it("reuses the same snapshot while the scope stays unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(contentArbitrary, async (content) => {
        await withFreshWorktree(async (worktree) => {
          await writeProjectFile(worktree, "specs/001-demo/spec.md", content)

          const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
          const second = await snapshotBeforeOperation(worktree, "pre-fix:two")

          expect(first.ok).toBe(true)
          expect(second.ok).toBe(true)
          expect(second.reused).toBe(true)
          expect(second.snapshotId).toBe(first.snapshotId)
          expect((await listSnapshots(worktree)).length).toBe(1)
        })
      }),
      { numRuns: 10 },
    )
  }, 60_000)

  it("creates a new snapshot whenever any captured file changes", async () => {
    await fc.assert(
      fc.asyncProperty(contentArbitrary, async (before) => {
        // Derives the second content from the first so the file always differs, because the property is about a change and not about two unrelated values.
        const after = `${before} changed`
        await withFreshWorktree(async (worktree) => {
          await writeProjectFile(worktree, "specs/001-demo/spec.md", before)

          const first = await snapshotBeforeOperation(worktree, "pre-fix:one")
          await writeProjectFile(worktree, "specs/001-demo/spec.md", after)
          const second = await snapshotBeforeOperation(worktree, "pre-fix:two")

          expect(second.reused).toBe(false)
          expect(second.snapshotId).not.toBe(first.snapshotId)
        })
      }),
      { numRuns: 10 },
    )
  }, 60_000)
})

describe("property: retention invariants", () => {
  it("never removes the newest snapshot and never removes a pinned snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(triggerArbitrary, { minLength: 2, maxLength: 9 }),
        fc.integer({ min: 0, max: 8 }),
        async (triggers, pinIndex) => {
          await withFreshWorktree(async (worktree) => {
            const times = sequenceTimes(triggers.length)
            const created: string[] = []
            for (const [index, trigger] of triggers.entries()) {
              const manifest = await createSnapshot(worktree, { trigger, now: times[index] })
              created.push(manifest.id)
            }

            const pinned = created[pinIndex % created.length]
            await pinSnapshot(worktree, pinned, "property")

            const report = await pruneSnapshots(worktree)

            const newest = created[created.length - 1]
            expect(report.removed).not.toContain(newest)
            expect(report.removed).not.toContain(pinned)
            expect(report.kept + report.removed.length).toBe(created.length)
          })
        },
      ),
      { numRuns: 8 },
    )
  }, 90_000)

  it("keeps the retained count inside the per feature cap when the cap is exceeded", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: AUTO_CAP_PER_FEATURE + 1, max: AUTO_CAP_PER_FEATURE + 5 }), async (count) => {
        await withFreshWorktree(async (worktree) => {
          const times = sequenceTimes(count)
          for (const [index] of times.entries()) {
            await createSnapshot(worktree, { trigger: "pre-fix:audit", now: times[index] })
          }

          const report = await pruneSnapshots(worktree)

          expect(report.removed.length).toBe(count - AUTO_CAP_PER_FEATURE)
          expect(report.kept).toBe(AUTO_CAP_PER_FEATURE)
          expect(report.kept).toBeLessThanOrEqual(TOTAL_CAP)
        })
      }),
      { numRuns: 5 },
    )
  }, 90_000)

  it("keeps every snapshot when the count stays inside the cap", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: AUTO_CAP_PER_FEATURE }), async (count) => {
        await withFreshWorktree(async (worktree) => {
          const times = sequenceTimes(count)
          for (const [index] of times.entries()) {
            await createSnapshot(worktree, { trigger: "pre-fix:audit", now: times[index] })
          }

          const report = await pruneSnapshots(worktree)

          expect(report.removed).toEqual([])
          expect(report.kept).toBe(count)
        })
      }),
      { numRuns: 5 },
    )
  }, 90_000)
})
