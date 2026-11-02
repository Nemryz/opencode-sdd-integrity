import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveInside, safeSegment, pathFragments, insideWorkspace, assertInsideWorkspace, LabPathError } from "../../lab/core/paths"

describe("Property: resolveInside never escapes the workspace", () => {
  it("for every candidate, the result is inside the workspace or it throws", () => {
    const workspace = "/tmp/lab-property-workspace"
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        try {
          const resolved = resolveInside(workspace, candidate)
          expect(resolved.startsWith(path.resolve(workspace) + path.sep) || resolved === path.resolve(workspace)).toBe(true)
        } catch (error) {
          expect(error).toBeInstanceOf(LabPathError)
        }
      }),
      { numRuns: 500 },
    )
  })
})

describe("Property: safeSegment round trips safe ids", () => {
  it("for every safe segment, safeSegment returns the same value", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== ".."),
        (id) => {
          expect(safeSegment(id)).toBe(id)
        },
      ),
      { numRuns: 300 },
    )
  })

  it("for every unsafe string, safeSegment throws", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === ".." || s === ""),
        (id) => {
          expect(() => safeSegment(id)).toThrow(LabPathError)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe("Property: pathFragments never contains empty strings", () => {
  it("for every string, pathFragments has no empty segments", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const fragments = pathFragments(value)
        for (const fragment of fragments) {
          expect(fragment).not.toBe("")
          expect(fragment.length).toBeGreaterThan(0)
        }
      }),
      { numRuns: 500 },
    )
  })
})

describe("Property: insideWorkspace agrees with resolveInside", () => {
  it("for every candidate, insideWorkspace and resolveInside agree on containment", () => {
    const workspace = "/tmp/lab-property-workspace"
    fc.assert(
      fc.property(fc.string().filter((s) => !/\\/.test(s)), (candidate) => {
        let insideThrew = false
        try {
          insideWorkspace(workspace, candidate)
        } catch {
          insideThrew = true
        }
        let resolvedThrew = false
        try {
          resolveInside(workspace, candidate)
        } catch {
          resolvedThrew = true
        }
        expect(insideThrew).toBe(resolvedThrew)
      }),
      { numRuns: 500 },
    )
  })
})

describe("Property: assertInsideWorkspace rejects everything resolveInside rejects", () => {
  it("for every candidate, assertInsideWorkspace throws exactly when resolveInside throws", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lab-property-ws-"))
    try {
      await fc.assert(
        fc.asyncProperty(fc.string().filter((s) => !/\\/.test(s)), async (candidate) => {
          let resolvedThrew = false
          try {
            resolveInside(workspace, candidate)
          } catch {
            resolvedThrew = true
          }
          let assertedThrew = false
          try {
            assertInsideWorkspace(workspace, candidate)
          } catch {
            assertedThrew = true
          }
          expect(assertedThrew).toBe(resolvedThrew)
        }),
        { numRuns: 300 },
      )
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("Property: Windows hazards never pass any guard", () => {
  const devices = ["CON", "PRN", "AUX", "NUL", "COM1", "COM5", "COM9", "LPT1", "LPT4", "LPT9"]
  const decorations = ["", ".txt", ".md"]
  const prefixes = ["", "nested/", "deeper/level/"]

  it("for every reserved device name, every guard throws", () => {
    fc.assert(
      fc.property(fc.constantFrom(...devices), fc.constantFrom(...decorations), fc.constantFrom(...prefixes), (device, decoration, prefix) => {
        const candidate = `${prefix}${device}${decoration}`
        expect(() => resolveInside(os.tmpdir(), candidate)).toThrow(LabPathError)
        expect(() => assertInsideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
        expect(() => insideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
      }),
      { numRuns: 200 },
    )
  })

  const letters = ["c", "d", "z", "C", "D", "Z"]
  const tails = [":", ":/host.txt", ":marker.txt"]
  const leadings = ["", "nested/"]

  it("for every drive letter shape, every guard throws", () => {
    fc.assert(
      fc.property(fc.constantFrom(...letters), fc.constantFrom(...tails), fc.constantFrom(...leadings), (letter, tail, leading) => {
        const candidate = `${leading}${letter}${tail}`
        expect(() => resolveInside(os.tmpdir(), candidate)).toThrow(LabPathError)
        expect(() => assertInsideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
        expect(() => insideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
      }),
      { numRuns: 150 },
    )
  })

  it("for every device stem, safeSegment throws instead of producing a sandbox id", () => {
    fc.assert(
      fc.property(fc.constantFrom(...devices), (device) => {
        expect(() => safeSegment(device.toLowerCase())).toThrow(LabPathError)
        expect(() => safeSegment(`${device}.txt`)).toThrow(LabPathError)
      }),
      { numRuns: 100 },
    )
  })
})
