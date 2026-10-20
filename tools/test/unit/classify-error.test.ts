import { describe, it, expect } from "vitest"
import { classifyError } from "../../install/installer.mjs"

describe("classifyError", () => {
  it("classifies ENOENT as not-found", () => {
    const err = new Error("npm not found") as Error & { code: string }
    err.code = "ENOENT"
    const result = classifyError(err)
    expect(result.type).toBe("not-found")
    expect(result.suggestion).toContain("Node.js")
  })

  it("classifies EACCES as permission", () => {
    const err = new Error("permission denied") as Error & { code: string }
    err.code = "EACCES"
    const result = classifyError(err)
    expect(result.type).toBe("permission")
    expect(result.suggestion).toContain("sudo")
  })

  it("classifies ECONNREFUSED as network", () => {
    const err = new Error("connection refused") as Error & { code: string }
    err.code = "ECONNREFUSED"
    const result = classifyError(err)
    expect(result.type).toBe("network")
    expect(result.suggestion).toContain("internet")
  })

  it("classifies ETIMEDOUT as timeout", () => {
    const err = new Error("timed out") as Error & { code: string }
    err.code = "ETIMEDOUT"
    const result = classifyError(err)
    expect(result.type).toBe("timeout")
    expect(result.suggestion).toContain("timed out")
  })

  it("classifies generic error as unknown", () => {
    const err = new Error("something went wrong")
    const result = classifyError(err)
    expect(result.type).toBe("unknown")
    expect(result.suggestion).toContain("verbose")
  })

  it("classifies string error as unknown", () => {
    const result = classifyError("some error string")
    expect(result.type).toBe("unknown")
    expect(result.message).toBe("some error string")
  })

  it("classifies error with ENOENT in message", () => {
    const err = new Error("ENOENT: no such file or directory")
    const result = classifyError(err)
    expect(result.type).toBe("not-found")
  })

  it("classifies error with permission denied in message", () => {
    const err = new Error("permission denied for path")
    const result = classifyError(err)
    expect(result.type).toBe("permission")
  })

  it("includes original message in result", () => {
    const err = new Error("original error message")
    const result = classifyError(err)
    expect(result.message).toBe("original error message")
  })

  it("handles null error gracefully", () => {
    const result = classifyError(null)
    expect(result.type).toBe("unknown")
    expect(result.message).toBe("null")
  })
})