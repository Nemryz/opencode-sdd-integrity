import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { repoPath } from "../helpers/setup"

const SCRIPT = repoPath(".github", "scripts", "report-score.mjs")
const BATCHES_FILE = repoPath("mutation-batches.json")
const TOOL_SOURCE = repoPath("tools", "speckit-mutation.ts")

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: repoPath() })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

// Builds the smallest report the metrics package reads, so the arithmetic is exercised without running Stryker.
function makeReport(mutants: Array<{ status: string }>): unknown {
  return {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60, break: null },
    testFiles: {},
    projectRoot: "",
    files: {
      "tools/sample.ts": {
        language: "typescript",
        mutants: mutants.map((mutant, index) => ({
          id: String(index),
          mutatorName: "ConditionalExpression",
          replacement: "false",
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          status: mutant.status,
          statusReason: "",
          coveredBy: [],
          killedBy: [],
          static: false,
        })),
      },
    },
  }
}

async function withReports<T>(
  entries: Array<{ name: string; mutants: Array<{ status: string }> }>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-score-"))
  try {
    for (const entry of entries) {
      await fs.writeFile(path.join(dir, `${entry.name}.json`), JSON.stringify(makeReport(entry.mutants)), "utf-8")
    }
    return await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("score script: one report", () => {
  it("reports the score the metrics package computes", async () => {
    await withReports([{ name: "a", mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }, { status: "NoCoverage" }] }], async (dir) => {
      const result = await runScript([path.join(dir, "a.json"), "alpha"])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("score=50.00")
      expect(result.stdout).toContain("killed=2")
      expect(result.stdout).toContain("valid=4")
    })
  })

  it("leaves invalid mutants out of the denominator", async () => {
    await withReports([{ name: "a", mutants: [{ status: "Killed" }, { status: "CompileError" }, { status: "CompileError" }] }], async (dir) => {
      const result = await runScript([path.join(dir, "a.json"), "alpha"])
      expect(result.stdout).toContain("score=100.00")
      expect(result.stdout).toContain("invalid=2")
    })
  })
})

describe("score script: several reports", () => {
  it("adds up the combined row instead of averaging the percentages", async () => {
    await withReports(
      [
        { name: "a", mutants: [{ status: "Killed" }, { status: "Survived" }] },
        { name: "b", mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Killed" }, { status: "Killed" }] },
      ],
      async (dir) => {
        const result = await runScript([path.join(dir, "a.json"), "alpha", path.join(dir, "b.json"), "beta"])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("| alpha |")
        expect(result.stdout).toContain("| beta |")
        expect(result.stdout).toContain("| **all** |")
        // A plain average of 50,00 and 100,00 would be 75,00, while five kills over six mutants is 83,33.
        expect(result.stdout).toContain("score=83.33")
      },
    )
  })

  it("names the combined row only when more than one report is given", async () => {
    await withReports([{ name: "a", mutants: [{ status: "Killed" }] }], async (dir) => {
      const result = await runScript([path.join(dir, "a.json"), "solo"])
      expect(result.stdout).not.toContain("**all**")
      expect(result.stdout).toContain("score=100.00")
    })
  })
})

describe("score ownership: one place computes the number", () => {
  it("takes the score from the metrics package rather than from local arithmetic", async () => {
    const source = await fs.readFile(SCRIPT, "utf-8")
    expect(source).toContain("mutation-testing-metrics")
    expect(source).not.toMatch(/killed\s*\/\s*valid/)
    expect(source).not.toMatch(/killed\s*\*\s*100/)
  })

  it("keeps the tool free of any score formula, because it delegates to the script", async () => {
    const source = await fs.readFile(TOOL_SOURCE, "utf-8")
    expect(source).toContain("report-score.mjs")
    expect(source, "the tool must not recompute the score").not.toContain("mutation-testing-metrics")
    expect(source).not.toMatch(/killed\s*\/\s*/)
  })

  it("keeps the batch list as the single source of which files are measured", async () => {
    const batches = JSON.parse(await fs.readFile(BATCHES_FILE, "utf-8")) as { batches: Array<{ id: string }> }
    expect(batches.batches.length).toBeGreaterThan(1)
    const tool = await fs.readFile(TOOL_SOURCE, "utf-8")
    expect(tool).toContain("mutation-batches.json")
    expect(tool).not.toMatch(/stryker\.conf\.json"\]\s*\n\s*\[/)
  })
})
