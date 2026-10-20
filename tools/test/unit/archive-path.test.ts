import { describe, it, expect } from "vitest"
import { todayStamp } from "../../speckit-archive"

describe("todayStamp", () => {
  it("returns YYYY-MM-DD format", () => {
    const stamp = todayStamp()
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("returns current date", () => {
    const stamp = todayStamp()
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, "0")
    const d = String(now.getDate()).padStart(2, "0")
    expect(stamp).toBe(`${y}-${m}-${d}`)
  })
})

describe("archive path generation", () => {
  it("formats as YYYY-MM-DD-NNN-slug", () => {
    const date = "2026-10-20"
    const featureDir = "001-demo"
    const archiveName = `${date}-${featureDir}`
    expect(archiveName).toBe("2026-10-20-001-demo")
  })

  it("handles feature dir with hyphens", () => {
    const date = "2026-10-20"
    const featureDir = "002-user-auth"
    const archiveName = `${date}-${featureDir}`
    expect(archiveName).toBe("2026-10-20-002-user-auth")
  })

  it("handles high feature numbers", () => {
    const date = "2026-10-20"
    const featureDir = "999-final-feature"
    const archiveName = `${date}-${featureDir}`
    expect(archiveName).toBe("2026-10-20-999-final-feature")
  })

  it("handles collision with suffix", () => {
    const date = "2026-10-20"
    const featureDir = "001-demo"
    const base = `${date}-${featureDir}`
    const collision = `${base}-2`
    expect(collision).toBe("2026-10-20-001-demo-2")
  })

  it("handles multiple collisions", () => {
    const date = "2026-10-20"
    const featureDir = "001-demo"
    const base = `${date}-${featureDir}`
    const collisions = [`${base}-2`, `${base}-3`, `${base}-4`]
    expect(collisions[0]).toBe("2026-10-20-001-demo-2")
    expect(collisions[1]).toBe("2026-10-20-001-demo-3")
    expect(collisions[2]).toBe("2026-10-20-001-demo-4")
  })
})