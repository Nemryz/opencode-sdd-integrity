import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"

const MODULES = ["paths", "manifest", "restore", "retention", "triggers"] as const

type ModuleName = (typeof MODULES)[number]

const SNAPSHOT_DIR = path.resolve(import.meta.dirname, "..", "..", "shared", "snapshot")

// Only these modules may sit on top of paths, so a lower layer can never reach back into a higher one.
const ALLOWED_INTERNAL_DEPENDENCIES: Record<ModuleName, ModuleName[]> = {
  paths: [],
  manifest: ["paths"],
  restore: ["manifest", "paths"],
  retention: ["manifest", "paths"],
  triggers: ["manifest", "retention", "paths"],
}

async function readModuleSource(name: ModuleName): Promise<string> {
  return fs.readFile(path.join(SNAPSHOT_DIR, `${name}.ts`), "utf-8")
}

// Collects every relative specifier so the graph can be checked without pulling a parser into the test.
function internalImports(source: string): ModuleName[] {
  const found: ModuleName[] = []
  const pattern = /from\s+"(\.\/[a-z]+)"/g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    const name = match[1].slice(2)
    if ((MODULES as readonly string[]).includes(name)) found.push(name as ModuleName)
    match = pattern.exec(source)
  }
  return found
}

function exportedNames(source: string): string[] {
  const names = new Set<string>()
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /export\s+(?:const|class|interface|type)\s+([A-Za-z0-9_]+)/g,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(source)
    while (match !== null) {
      names.add(match[1])
      match = pattern.exec(source)
    }
  }
  return [...names]
}

describe("snapshot modules: structure after the split", () => {
  it("has one file per planned module and no barrel left behind", async () => {
    const entries = await fs.readdir(SNAPSHOT_DIR)
    const modules = entries.filter((entry) => entry.endsWith(".ts")).sort()
    expect(modules).toEqual([...MODULES].sort().map((name) => `${name}.ts`))
    expect(entries).not.toContain("index.ts")
    expect(entries).not.toContain("snapshot.ts")
    await expect(fs.access(path.resolve(import.meta.dirname, "..", "..", "shared", "snapshot.ts"))).rejects.toThrow()
  })

  it("keeps every internal dependency inside the allowed direction", async () => {
    for (const name of MODULES) {
      const deps = [...new Set(internalImports(await readModuleSource(name)))].sort()
      expect(deps, `${name}.ts imports outside its allowed layer`).toEqual([...ALLOWED_INTERNAL_DEPENDENCIES[name]].sort())
    }
  })

  it("exposes the documented public surface of each module", async () => {
    const expected: Record<ModuleName, string[]> = {
      paths: [
        "snapshotsDirPath",
        "restoreJournalPath",
        "pinPath",
        "drillPath",
        "collectScope",
        "sha256",
        "formatTimestamp",
        "slugifyTrigger",
        "pathExists",
        "assertSafeManifestPath",
        "readPinInfo",
        "readDrillInfo",
        "readRestoreJournal",
        "writeRestoreJournal",
        "clearRestoreJournal",
      ],
      manifest: [
        "CreateSnapshotOptions",
        "createSnapshot",
        "readSnapshotManifest",
        "SnapshotVerification",
        "verifySnapshot",
        "SnapshotListEntry",
        "listSnapshots",
      ],
      restore: [
        "RestorePreview",
        "previewRestore",
        "RestoreOptions",
        "RestoreReport",
        "restoreSnapshot",
        "RestoreRecovery",
        "recoverInterruptedRestore",
      ],
      retention: [
        "pinSnapshot",
        "unpinSnapshot",
        "drillSnapshot",
        "AUTO_CAP_PER_FEATURE",
        "TOTAL_CAP",
        "PruneReport",
        "pruneSnapshots",
        "computeRecoveryReadiness",
      ],
      triggers: [
        "TriggerSnapshotOptions",
        "TriggerSnapshotResult",
        "snapshotBeforeOperation",
        "FailureSnapshotResult",
        "postFailureNote",
        "snapshotAfterFailure",
      ],
    }
    for (const name of MODULES) {
      const actual = exportedNames(await readModuleSource(name))
      for (const symbol of expected[name]) {
        expect(actual, `${name}.ts must export ${symbol}`).toContain(symbol)
      }
    }
  })

  it("keeps manifest.json a concern of the manifest layer alone", async () => {
    for (const name of MODULES) {
      const source = await readModuleSource(name)
      if (name === "manifest") {
        expect(source).toContain('"manifest.json"')
        expect(source).toContain("atomicWriteFile")
        continue
      }
      expect(source, `${name}.ts must not read or write manifest.json`).not.toContain("manifest.json")
    }
  })

  it("reads its own state through schemas instead of parsing JSON by hand", async () => {
    const expectedSchemas: Record<ModuleName, string[]> = {
      paths: [],
      manifest: ["SnapshotManifestSchema"],
      restore: ["RestoreJournal"],
      retention: ["SnapshotPinSchema", "SnapshotDrillSchema"],
      triggers: [],
    }
    for (const name of MODULES) {
      const source = await readModuleSource(name)
      for (const symbol of expectedSchemas[name]) {
        expect(source, `${name}.ts must reuse ${symbol}`).toContain(symbol)
      }
    }
  })

  it("gives every module a single owner comment describing its responsibility", async () => {
    for (const name of MODULES) {
      const source = await readModuleSource(name)
      const owners = source.split("\n").filter((line) => line.startsWith("// This module owns"))
      expect(owners, `${name}.ts needs exactly one owner comment`).toHaveLength(1)
      expect(owners[0].length).toBeLessThan(140)
    }
  })
})
