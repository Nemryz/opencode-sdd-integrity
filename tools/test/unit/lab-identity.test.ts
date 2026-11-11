import { describe, it, expect } from "vitest"
import {
  isLabEntityId,
  makeEvidenceId,
  makePatchId,
  makePromotionId,
  makeTaskId,
} from "../../lab/core/identity"

describe("lab identity makers", () => {
  it("produces safe ids for every entity the provenance chain needs", () => {
    const ids = [makeTaskId(), makePatchId(), makeEvidenceId(), makePromotionId()]
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(id.length).toBeGreaterThan(10)
    }
    expect(ids[0]).toMatch(/^task-/)
    expect(ids[1]).toMatch(/^patch-/)
    expect(ids[2]).toMatch(/^evidence-/)
    expect(ids[3]).toMatch(/^promotion-/)
  })

  it("never repeats an id across calls", () => {
    const seen = new Set<string>()
    for (let index = 0; index < 50; index++) {
      for (const id of [makeTaskId(), makePatchId(), makeEvidenceId(), makePromotionId()]) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
  })

  it("accepts only safe entity ids", () => {
    expect(isLabEntityId("20261102000000-abcdefab")).toBe(true)
    expect(isLabEntityId("patch-20261102000000-abcdefab")).toBe(true)
    expect(isLabEntityId("")).toBe(false)
    expect(isLabEntityId("../escape")).toBe(false)
    expect(isLabEntityId("bad id with space")).toBe(false)
    expect(isLabEntityId(null)).toBe(false)
    expect(isLabEntityId(42)).toBe(false)
  })
})
