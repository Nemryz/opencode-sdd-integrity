import { describe, it, expect } from "vitest"
import path from "node:path"
import {
  stripBom,
  computeBodyChecksum,
  backupSourceKey,
  isEEXIST,
  isENOENT,
  isESRCH,
} from "../../shared/io"

function errorWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe("matrix: stripBom", () => {
  it.each([
    ["\uFEFFplain text after bom", "plain text after bom"],
    ["no bom at all", "no bom at all"],
    ["", ""],
    ["\uFEFF", ""],
    ["\uFEFF\uFEFFdouble bom", "\uFEFFdouble bom"],
    ["\uFEFF{\"json\":true}", "{\"json\":true}"],
  ])("stripBom(%j) -> %j", (input, expected) => {
    expect(stripBom(input as string)).toBe(expected)
  })

  it("only strips a leading BOM, never one in the middle", () => {
    expect(stripBom("a\uFEFFb")).toBe("a\uFEFFb")
  })
})

describe("matrix: computeBodyChecksum", () => {
  const cases: Array<[string, string, string]> = [
    ["identical body", "---\nphase: spec\n---\nbody", "---\nphase: spec\n---\nbody"],
    ["CRLF vs LF", "---\nphase: spec\n---\nline one\r\nline two", "---\nphase: spec\n---\nline one\nline two"],
    ["trailing whitespace", "---\nphase: spec\n---\nbody   ", "---\nphase: spec\n---\nbody"],
    ["leading whitespace", "---\nphase: spec\n---\n   body", "---\nphase: spec\n---\nbody"],
  ]

  it.each(cases)("%s produces %s", (_label, first, second) => {
    expect(computeBodyChecksum(first)).toBe(computeBodyChecksum(second))
  })

  it.each([
    ["body change", "---\nphase: spec\n---\nbody", "---\nphase: spec\n---\nbody2"],
    ["unicode vs ascii", "---\nphase: spec\n---\ncuerpo", "---\nphase: spec\n---\nbody"],
  ])("%s produces different checksums", (_label, first, second) => {
    expect(computeBodyChecksum(first)).not.toBe(computeBodyChecksum(second))
  })

  it("empty content has a stable checksum and matches whitespace-only content", () => {
    expect(computeBodyChecksum("")).toBe(computeBodyChecksum("   \n  "))
    expect(computeBodyChecksum("")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("matrix: backupSourceKey", () => {
  it.each([
    ["plain file", path.join("tmp", "project", "session.json")],
    ["nested file", path.join("tmp", "project", ".opencode", "spec-memory", "session.json")],
    ["dotted name", path.join("tmp", "project", "guard.json")],
    ["spaces in name", path.join("tmp", "project", "my file.json")],
  ])("%s -> <basename>.<8 hex>", (label, fp) => {
    expect(label.length).toBeGreaterThan(0)
    const key = backupSourceKey(fp)
    expect(key.startsWith(`${path.basename(fp)}.`)).toBe(true)
    expect(key).toMatch(/\.[0-9a-f]{8}$/)
  })

  it("is stable for the same path and different for different paths", () => {
    expect(backupSourceKey(path.join("tmp", "a", "config.json")))
      .toBe(backupSourceKey(path.join("tmp", "a", "config.json")))
    expect(backupSourceKey(path.join("tmp", "a", "config.json")))
      .not.toBe(backupSourceKey(path.join("tmp", "b", "config.json")))
  })

  it("same basename in the same directory resolves to the same key", () => {
    expect(backupSourceKey(path.join("tmp", "a", "spec.json")))
      .toBe(backupSourceKey(path.join("tmp", "a", "./spec.json")))
  })

  it.skipIf(process.platform !== "win32")("ignores directory casing on Windows", () => {
    expect(backupSourceKey("C:\\Tmp\\A\\config.json").split(".").pop())
      .toBe(backupSourceKey("c:\\tmp\\a\\config.json").split(".").pop())
  })
})

describe("matrix: errno matchers", () => {
  const matchers: Array<[string, (err: unknown) => boolean, string]> = [
    ["isEEXIST", isEEXIST, "EEXIST"],
    ["isENOENT", isENOENT, "ENOENT"],
    ["isESRCH", isESRCH, "ESRCH"],
  ]

  it.each(matchers)("%s matches only its own code", (_label, matcher, code) => {
    expect(matcher(errorWithCode(code))).toBe(true)
    for (const other of ["EEXIST", "ENOENT", "ESRCH", "EPERM"]) {
      if (other === code) continue
      expect(matcher(errorWithCode(other))).toBe(false)
    }
  })

  it.each(matchers)("%s rejects non-error inputs", (_label, matcher) => {
    expect(matcher(null)).toBe(false)
    expect(matcher(undefined)).toBe(false)
    expect(matcher("EEXIST")).toBe(false)
    expect(matcher(new Error("plain"))).toBe(false)
    expect(matcher({ code: 42 })).toBe(false)
  })
})