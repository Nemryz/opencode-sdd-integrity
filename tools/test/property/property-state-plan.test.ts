import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  createStatePlan,
  hashScope,
  applyStatePlan,
  recoverStateTransactions,
  writeSession,
  type SessionState,
} from "../../shared/types"
import { removeDirWithRetry } from "../helpers/setup"

let root: string

function session(history: string[]): SessionState {
  return {
    command: "property",
    phase: "spec",
    featureDir: null,
    featureNumber: null,
    featureName: null,
    nextStep: "/plan",
    lastResult: null,
    history,
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "property-state-plan-"))
  await fs.mkdir(path.join(root, ".opencode", "spec-memory"), { recursive: true })
})

afterEach(async () => {
  await removeDirWithRetry(root)
})

describe("Property: state plan determinism", () => {
  it("produces the same base, expected and plan hashes for the same input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 32 }), { maxLength: 25 }),
        async (history) => {
          await writeSession(root, session([]))
          const input = {
            root,
            scope: [".opencode/spec-memory/session.json"],
            preconditions: [],
            operations: [{ kind: "write-session" as const, data: session(history) }],
            now: new Date("2026-10-22T00:00:00.000Z"),
            planId: "property-plan",
          }
          const first = await createStatePlan(input)
          const second = await createStatePlan(input)

          expect(second.baseHash).toBe(first.baseHash)
          expect(second.expectedHash).toBe(first.expectedHash)
          expect(second.planHash).toBe(first.planHash)
          expect(second.operations).toEqual(first.operations)
        },
      ),
      { numRuns: 25 },
    )
  })

  it("keeps the simulated hash equal to the hash after apply", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 32 }), { maxLength: 25 }),
        async (history) => {
          await writeSession(root, session([]))
          const plan = await createStatePlan({
            root,
            scope: [".opencode/spec-memory/session.json"],
            preconditions: [],
            operations: [{ kind: "write-session", data: session(history) }],
            now: new Date("2026-10-22T00:00:00.000Z"),
            planId: `property-${history.length}`,
          })
          await applyStatePlan(root, plan)
          expect(await hashScope(root, plan.scope)).toBe(plan.expectedHash)
        },
      ),
      { numRuns: 25 },
    )
  })

  it("is idempotent when recovery finds nothing left to recover", async () => {
    const first = await recoverStateTransactions(root)
    const second = await recoverStateTransactions(root)
    expect(first.recovered).toEqual([])
    expect(second.recovered).toEqual([])
  })
})
