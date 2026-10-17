import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { repoPath } from "../helpers/setup"

const TOOLS_DIR = repoPath("tools")

// Modules that may mention these calls only to reason about the user location, never to resolve a resource from it.
const ALLOWED = new Map<string, string>([
  ["tools/speckit-scaffold.ts", "last resort home copy after an upward search finds nothing"],
  ["tools/shared/types.ts", "warns when the project root is the kit installation directory"],
])

async function toolModules(): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "test") continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
      else if (entry.name.endsWith(".ts")) found.push(`tools/${rel}`)
    }
  }
  await walk(TOOLS_DIR, "")
  return found.sort()
}

function linesUsing(source: string, needle: string): string[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.includes(needle) && !entry.line.trim().startsWith("//"))
    .map((entry) => `line ${entry.number}`)
}

describe("resource resolution: no tool may read its own resources from the home or the working directory", () => {
  it("finds the tool modules to inspect", async () => {
    expect((await toolModules()).length).toBeGreaterThan(10)
  })

  it.each(["os.homedir()", "process.cwd()"])("%s appears only in allowlisted modules", async (needle) => {
    const offenders: string[] = []
    for (const rel of await toolModules()) {
      const abs = path.join(REPO_ROOT, ...rel.split("/"))
      if (!existsSync(abs)) continue
      const hits = linesUsing(await fs.readFile(abs, "utf-8"), needle)
      if (hits.length === 0) continue
      if (ALLOWED.has(rel)) continue
      offenders.push(`${rel} (${hits.join(", ")})`)
    }
    expect(offenders, `resolve resources from a location that only exists on one machine`).toEqual([])
  })

  it("keeps an allowlist entry that no longer applies from hiding a real one", async () => {
    const modules = await toolModules()
    for (const rel of ALLOWED.keys()) {
      expect(modules, `allowlist mentions ${rel}, which no longer exists`).toContain(rel)
    }
  })

  it("states a reason for every allowlist entry, because an unexplained exception rots", async () => {
    for (const [rel, reason] of ALLOWED) {
      expect(rel.startsWith("tools/")).toBe(true)
      expect(reason.length).toBeGreaterThan(20)
      const abs = path.join(REPO_ROOT, ...rel.split("/"))
      const source = await fs.readFile(abs, "utf-8")
      expect(source, `${rel} is allowlisted but no longer mentions os.homedir()`).toContain("os.homedir()")
    }
  })
})

const REPO_ROOT = repoPath()
