import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import mutationTool, { findKitRoot, readBatches, reportPathFor, summarizeFailure } from "../../speckit-mutation"
import { MutationBatchesSchema } from "../../shared/schemas"
import { mockContext } from "../helpers/setup"
import { repoPath } from "../helpers/setup"

const KIT_ROOT = repoPath()

async function run(subcommand?: string) {
  const ctx = mockContext(KIT_ROOT)
  return mutationTool.execute(subcommand === undefined ? {} : ({ subcommand } as never), ctx)
}

describe("mutation tool: kit checkout detection", () => {
  it("finds the checkout from the tool location", () => {
    expect(findKitRoot(path.join(KIT_ROOT, "tools"))).toBe(KIT_ROOT)
  })

  it("returns null when no ancestor carries the batch list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-no-kit-"))
    try {
      expect(findKitRoot(path.join(dir, "a", "b", "c"))).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("ignores a directory that holds the batch list without the stryker config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-partial-"))
    try {
      await fs.writeFile(path.join(dir, "mutation-batches.json"), "{}", "utf-8")
      expect(findKitRoot(dir)).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("mutation tool: reading the batch list", () => {
  it("reads the repository file through the schema", async () => {
    const batches = await readBatches(KIT_ROOT)
    expect(batches.length).toBeGreaterThan(1)
    const raw = JSON.parse(await fs.readFile(repoPath("mutation-batches.json"), "utf-8"))
    expect(MutationBatchesSchema.safeParse(raw).success).toBe(true)
    expect(batches.map((batch) => batch.id)).toEqual(raw.batches.map((batch: { id: string }) => batch.id))
  })

  it("stores one report per batch under a predictable path", () => {
    expect(reportPathFor(KIT_ROOT, "shared-io")).toBe(
      path.join(KIT_ROOT, "reports", "mutation", "batches", "shared-io", "mutation.json"),
    )
  })
})

describe("mutation tool: list", () => {
  it("lists every batch with its file count and whether it was measured", async () => {
    const result = await run("list")
    const batches = await readBatches(KIT_ROOT)

    expect(result.title).toBe("Mutation Batches")
    for (const batch of batches) {
      expect(result.output).toContain(batch.id)
    }
    expect(result.output).toContain(`${batches.length} batches`)
    expect(result.output).toMatch(/measured|pending/)
  })

  it("defaults to list when no subcommand arrives", async () => {
    const result = await run(undefined)
    expect(result.title).toBe("Mutation Batches")
  })
})

describe("mutation tool: run", () => {
  it("refuses an unknown batch and names the ones that exist", async () => {
    const result = await run("run not-a-batch")
    expect(result.title).toBe("Unknown batch")
    expect(result.output).toContain("not-a-batch")
    expect(result.output).toContain("snapshot-paths")
  })

  it("asks for a batch instead of starting the whole matrix by accident", async () => {
    const result = await run("run")
    expect(result.title).toBe("No batch requested")
    expect(result.output).toContain("run snapshot-paths")
  })
})

describe("mutation tool: aggregate", () => {
  // Stored reports live under an ignored folder, so a checkout that already ran a batch locally skips this case.
  const storedReports = existsSync(path.join(KIT_ROOT, "reports", "mutation", "batches"))

  it.skipIf(storedReports)("says so plainly when no batch has been measured yet", async () => {
    const result = await run("aggregate")
    expect(result.title).toBe("Nothing to aggregate")
    expect(result.output).toContain("reports")
    expect(result.output).toContain("Run a batch first")
  })

  it.skipIf(!storedReports)("adds up every stored report through the score script", async () => {
    const result = await run("aggregate")
    expect(result.title).toMatch(/^Mutation score over \d+ batch/)
    expect(result.output).toContain("score=")
  })
})

describe("mutation tool: failure output", () => {
  it("spawns without a shell, because a shell splits the interpreter path on the space in Program Files", async () => {
    const source = await fs.readFile(repoPath("tools", "speckit-mutation.ts"), "utf-8")
    expect(source).not.toContain("shell: true")
    expect(source).not.toContain("npx")
    expect(source).toContain("@stryker-mutator")
    expect(source).toContain("process.execPath")
  })

  it("checks the Stryker entry point exists before spawning it", async () => {
    const source = await fs.readFile(repoPath("tools", "speckit-mutation.ts"), "utf-8")
    expect(source).toContain("stryker.js")
    expect(source).toContain("Stryker not installed")
    expect(source).toContain("npm install")
  })

  it("surfaces the failing test names instead of the stack that ends the log", () => {
    const output = [
      "INFO Instrumenter Instrumented 2 source file(s) with 259 mutant(s)",
      "ERROR DryRunExecutor One or more tests failed in the initial test run:",
      "\tsome test > does the thing",
      "\t\tAssertionError: expected true to be false",
      "Error: Something went wrong in the initial test run",
      "    at DryRunExecutor.validateResultCompleted (/very/long/path.js:76:15)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
    ].join("\n")

    const summary = summarizeFailure(output)
    expect(summary).toContain("One or more tests failed")
    expect(summary).toContain("some test > does the thing")
    expect(summary).toContain("AssertionError")
    expect(summary).not.toContain("processTicksAndRejections")
  })

  it("falls back to the error lines when Stryker never names a test", () => {
    const output = [
      "INFO ProjectReader Found 2 of 179 file(s) to be mutated.",
      "Error: Cannot resolve module",
      "    at somewhere.js:1:1",
      "    at elsewhere.js:2:2",
    ].join("\n")

    const summary = summarizeFailure(output)
    expect(summary).toContain("Cannot resolve module")
    expect(summary).not.toContain("elsewhere.js")
  })

  it("keeps the tail when the output says nothing recognizable", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`)
    const summary = summarizeFailure(lines.join("\n"))
    expect(summary).toContain("line 39")
    expect(summary).not.toContain("line 0")
  })

  it("handles empty output without throwing", () => {
    expect(summarizeFailure("")).toBe("")
  })
})

describe("mutation tool: unknown input", () => {
  it("rejects a subcommand it does not implement", async () => {
    const result = await run("bogus")
    expect(result.title).toBe("Error")
    expect(result.output).toContain("Unknown subcommand")
  })
})
