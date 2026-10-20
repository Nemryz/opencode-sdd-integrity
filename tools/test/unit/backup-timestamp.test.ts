import { describe, it, expect } from "vitest"
import { backupTimestamp } from "../../shared/io"

describe("backupTimestamp", () => {
  it("extracts timestamp from backup filename", () => {
    expect(backupTimestamp("spec.json.20261020T215017Z-172f65.bak")).toBe(20261020215017)
  })

  it("returns 0 for filename without timestamp", () => {
    expect(backupTimestamp("spec.json.bak")).toBe(0)
  })

  it("returns 0 for empty string", () => {
    expect(backupTimestamp("")).toBe(0)
  })

  it("handles .sha256 extension", () => {
    // .sha256 files don't match the .bak pattern at the end
    expect(backupTimestamp("spec.json.20261020T215017Z-172f65.bak.sha256")).toBe(0)
  })

  it("handles different source keys", () => {
    expect(backupTimestamp("AGENTS.md.a1b2c3d4.20261020T220000Z-abcd12.bak")).toBe(20261020220000)
  })

  it("handles timestamp with leading zeros", () => {
    expect(backupTimestamp("file.txt.20260101T010203Z-000000.bak")).toBe(20260101010203)
  })
})

describe("backupTimestamp sorting", () => {
  it("sorts newer first", () => {
    const names = [
      "spec.json.20261020T215017Z-172f65.bak",
      "spec.json.20261020T220000Z-abcd12.bak",
      "spec.json.20261020T210000Z-000000.bak",
    ]
    const sorted = names.sort((a, b) => backupTimestamp(b) - backupTimestamp(a))
    expect(sorted[0]).toBe("spec.json.20261020T220000Z-abcd12.bak")
    expect(sorted[1]).toBe("spec.json.20261020T215017Z-172f65.bak")
    expect(sorted[2]).toBe("spec.json.20261020T210000Z-000000.bak")
  })
})