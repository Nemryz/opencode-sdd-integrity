import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { ownedRepoFiles } from "../helpers/setup"

// Scanned text files are the ones where prose or comments live, so binaries and locks are skipped.
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".md", ".jsonc", ".yml", ".yaml", ".sh", ".ps1"]

const SKIPPED_FILES = ["package-lock.json"]

// Ranges cover Cyrillic, kana, CJK ideographs, Hangul and fullwidth forms which never belong in English source.
const FORBIDDEN_RANGES: Array<[string, number, number]> = [
  ["Cyrillic", 0x0400, 0x04ff],
  ["Cyrillic supplement", 0x0500, 0x052f],
  ["Cyrillic extended", 0x1c80, 0x1c8f],
  ["Greek", 0x0370, 0x03ff],
  ["Hiragana", 0x3040, 0x309f],
  ["Katakana", 0x30a0, 0x30ff],
  ["CJK punctuation", 0x3000, 0x303f],
  ["CJK ideographs", 0x4e00, 0x9fff],
  ["Hangul syllables", 0xac00, 0xd7af],
  ["Fullwidth forms", 0xff00, 0xffef],
]

function findForbiddenCharacters(text: string): Array<{ script: string; char: string }> {
  const found: Array<{ script: string; char: string }> = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    for (const [script, start, end] of FORBIDDEN_RANGES) {
      if (code >= start && code <= end) {
        found.push({ script, char })
      }
    }
  }
  return found
}

// Removes quoted segments so unicode literals inside tests do not count as prose violations.
function stripLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
}

function scanTarget(relPath: string): boolean {
  if (SKIPPED_FILES.includes(relPath)) return false
  if (relPath.endsWith(".tsx") || relPath.endsWith(".js") || relPath.endsWith(".mjs")) return true
  const extension = path.extname(relPath)
  if (!SCANNED_EXTENSIONS.includes(extension)) return false
  // Test fixtures may embed hostile unicode on purpose, so they are checked by their own fuzz suites.
  if (relPath.startsWith("tools/test/fuzz/") && !relPath.includes("language-lint")) return false
  return true
}

describe("language lint: source stays in English", () => {
  const tracked = [...ownedRepoFiles()].filter(scanTarget)
  // Repositories without git metadata carry no tracked file list, so the scan has nothing to walk.
  const needsGit = ownedRepoFiles().size > 0

  it.skipIf(!needsGit)("finds tracked files to scan", () => {
    expect(tracked.length).toBeGreaterThan(20)
  })

  it.skipIf(!needsGit)("reports files that use Cyrillic, Greek, Japanese, Chinese or Korean characters", async () => {
    const violations: string[] = []

    for (const relPath of tracked) {
      const content = await fs.readFile(path.resolve(import.meta.dirname, "..", "..", "..", ...relPath.split("/")), "utf-8")
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        const found = findForbiddenCharacters(stripLiterals(lines[index]))
        for (const hit of found) {
          violations.push(`${relPath}:${index + 1} ${hit.script} ${JSON.stringify(hit.char)}`)
        }
      }
    }

    expect(violations, `non English characters found\n${violations.slice(0, 20).join("\n")}`).toEqual([])
  })

  it("flags forbidden characters when they appear in code or comments", () => {
    expect(findForbiddenCharacters("// проверка")).toHaveLength(8)
    expect(findForbiddenCharacters('const label = "日本語のみ"')).toHaveLength(5)
    expect(findForbiddenCharacters("const t = `가나다`")).toHaveLength(3)
  })

  it("accepts latin text with accents and punctuation used by the kit", () => {
    expect(findForbiddenCharacters("// revisa el estado y compara los valores")).toEqual([])
    expect(findForbiddenCharacters("const value = 1 // counts files")).toEqual([])
    expect(findForbiddenCharacters("")).toEqual([])
  })

  it("ignores unicode inside string literals of source files", () => {
    expect(findForbiddenCharacters(stripLiterals('const label = "日本語のみ" // trigger slug'))).toEqual([])
    expect(findForbiddenCharacters(stripLiterals("const label = 'ñandú ✓'"))).toEqual([])
    expect(findForbiddenCharacters(stripLiterals("const tpl = `feature ${name}`"))).toEqual([])
  })

  it("still catches forbidden characters placed next to a literal", () => {
    expect(findForbiddenCharacters(stripLiterals('const a = "ok" // 日本語'))).not.toEqual([])
  })
})