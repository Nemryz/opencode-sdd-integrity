import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { MutationBatchSchema, MutationBatchesSchema } from "../../shared/schemas"

// A valid batch is the smallest input that the workflow and the tools both accept.
function validBatch() {
  return {
    id: "snapshot-paths",
    description: "Snapshot layout and the trigger that guards risky operations",
    mutate: ["tools/shared/snapshot/paths.ts"],
  }
}

function validBatches() {
  return { format: 1 as const, batches: [validBatch()] }
}

describe("fuzz: MutationBatchSchema", () => {
  it.each([
    ["plain kebab id", "shared-io", true],
    ["single word id", "io", true],
    ["digits inside", "tools-flow-2", true],
    ["uppercase id", "Shared-IO", false],
    ["leading dash", "-shared", false],
    ["trailing dash", "shared-", false],
    ["double dash", "shared--io", false],
    ["underscore id", "shared_io", false],
    ["space inside id", "shared io", false],
    ["empty id", "", false],
    ["id with slash", "shared/io", false],
    ["id with dot", "shared.io", false],
  ] as Array<[string, string, boolean]>)("id %s -> %s", (_label, id, accepted) => {
    expect(MutationBatchSchema.safeParse({ ...validBatch(), id }).success).toBe(accepted)
  })

  it.each([
    ["one path", ["tools/shared/io.ts"], true],
    ["four paths", ["a.ts", "b.ts", "c.ts", "d.ts"], true],
    ["empty list", [], false],
    ["empty string entry", [""], false],
    ["numeric entry", [42], false],
    ["null entry", [null], false],
    ["nested array", [["a.ts"]], false],
    ["object entry", [{ path: "a.ts" }], false],
  ] as Array<[string, unknown[], boolean]>)("mutate %s -> %s", (_label, mutate, accepted) => {
    expect(MutationBatchSchema.safeParse({ ...validBatch(), mutate }).success).toBe(accepted)
  })

  it.each([
    ["sentence", "Atomic writes, backups, corruption detection", true],
    ["single character", "a", true],
    ["unicode", "Rutas del sistema y su copia", true],
    ["empty", "", false],
    ["whitespace only", "   ", false],
    ["null", null, false],
    ["number", 7, false],
  ] as Array<[string, unknown, boolean]>)("description %s -> %s", (_label, description, accepted) => {
    expect(MutationBatchSchema.safeParse({ ...validBatch(), description }).success).toBe(accepted)
  })

  it("rejects a batch that is not an object at all", () => {
    expect(MutationBatchSchema.safeParse(null).success).toBe(false)
    expect(MutationBatchSchema.safeParse("shared-io").success).toBe(false)
    expect(MutationBatchSchema.safeParse([validBatch()]).success).toBe(false)
  })

  it("strips unknown keys instead of failing", () => {
    const parsed = MutationBatchSchema.parse({ ...validBatch(), injected: "value" } as never)
    expect("injected" in parsed).toBe(false)
  })
})

describe("fuzz: MutationBatchesSchema", () => {
  it.each([
    ["format 1", 1, true],
    ["format 2", 2, false],
    ["format as string", "1", false],
    ["format null", null, false],
    ["format missing", undefined, false],
  ] as Array<[string, unknown, boolean]>)("format %s -> %s", (_label, format, accepted) => {
    const candidate = format === undefined ? { batches: [validBatch()] } : { format, batches: [validBatch()] }
    expect(MutationBatchesSchema.safeParse(candidate).success).toBe(accepted)
  })

  it.each([
    ["one batch", [validBatch()], true],
    ["two batches", [validBatch(), { ...validBatch(), id: "shared-io" }], true],
    ["no batches", [], false],
    ["batch with bad id", [{ ...validBatch(), id: "Shared" }], false],
    ["batch as string", ["shared-io"], false],
    ["batches as object", { "shared-io": validBatch() }, false],
    ["batches null", null, false],
  ] as Array<[string, unknown, boolean]>)("batches %s -> %s", (_label, batches, accepted) => {
    expect(MutationBatchesSchema.safeParse({ format: 1, batches }).success).toBe(accepted)
  })

  it("accepts any generated batch that keeps the required shape", () => {
    const idArb = fc.stringMatching(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    fc.assert(
      fc.property(idArb, fc.string({ minLength: 1 }), fc.array(fc.stringMatching(/^[a-z/]+\.ts$/), { minLength: 1 }), (id, description, mutate) => {
        expect(MutationBatchesSchema.safeParse({ format: 1, batches: [{ id, description, mutate }] }).success).toBe(true)
      }),
      { numRuns: 50 },
    )
  })

  it("never crashes on hostile input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => MutationBatchesSchema.safeParse(value)).not.toThrow()
        expect(() => MutationBatchSchema.safeParse(value)).not.toThrow()
      }),
      { numRuns: 100 },
    )
  })
})
