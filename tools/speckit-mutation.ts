import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { MutationBatchesSchema, type MutationBatch } from "./shared/schemas"

// This module owns the mutation workflow of the kit itself, meaning listing batches, running them and adding their scores up.

const BATCHES_FILE = "mutation-batches.json"
const STRYKER_CONFIG = "stryker.conf.json"
const SCORE_SCRIPT = path.join(".github", "scripts", "report-score.mjs")
const REPORTS_DIR = path.join("reports", "mutation", "batches")

// The batch list lives beside the tools rather than in the project, because measuring the kit is a job for a kit checkout.
function findKitRoot(startDir: string, maxLevels = 6): string | null {
  let current = startDir
  for (let level = 0; level <= maxLevels; level++) {
    if (existsSync(path.join(current, BATCHES_FILE)) && existsSync(path.join(current, STRYKER_CONFIG))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

function reportPathFor(kitRoot: string, batchId: string): string {
  return path.join(kitRoot, REPORTS_DIR, batchId, "mutation.json")
}

async function readBatches(kitRoot: string): Promise<MutationBatch[]> {
  const raw = await fs.readFile(path.join(kitRoot, BATCHES_FILE), "utf-8")
  const parsed = MutationBatchesSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(`${BATCHES_FILE} does not satisfy MutationBatchesSchema`)
  }
  return parsed.data.batches
}

function runCommand(cwd: string, command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }))
  })
}

async function countLines(kitRoot: string, files: string[]): Promise<number> {
  let total = 0
  for (const file of files) {
    const content = await fs.readFile(path.join(kitRoot, ...file.split("/")), "utf-8")
    total += content.split(/\r?\n/).length
  }
  return total
}

export default tool({
  description: "List, run and aggregate the mutation batches of this kit",
  args: {
    subcommand: tool.schema.string().optional().describe("Subcommand: 'list', 'run <batch...>' or 'aggregate'"),
  },
  async execute(args) {
    const kitRoot = findKitRoot(import.meta.dirname)
    if (!kitRoot) {
      return {
        title: "Not a kit checkout",
        output: `This command needs a checkout of the kit because ${BATCHES_FILE} lives beside the tools. Run it from a clone of the repository.`,
      }
    }

    try {
      const batches = await readBatches(kitRoot)
      const subcommand = args.subcommand?.trim() ?? "list"
      const known = new Map(batches.map((batch) => [batch.id, batch]))

      if (subcommand === "list") {
        const lines: string[] = ["Mutation batches", ""]
        let totalFiles = 0
        for (const batch of batches) {
          const hasReport = existsSync(reportPathFor(kitRoot, batch.id))
          totalFiles += batch.mutate.length
          lines.push(`  ${batch.id.padEnd(22)} ${String(batch.mutate.length).padStart(2)} files  ${hasReport ? "measured" : "pending"}`)
          lines.push(`  ${" ".repeat(22)} ${batch.description}`)
        }
        lines.push("", `${batches.length} batches over ${totalFiles} files`)
        return { title: "Mutation Batches", output: lines.join("\n") }
      }

      if (subcommand.startsWith("run")) {
        const requested = subcommand.split(/\s+/).slice(1)
        if (requested.length === 0) {
          return {
            title: "No batch requested",
            output: "Name at least one batch, for example: run snapshot-paths",
          }
        }
        const unknown = requested.filter((id) => !known.has(id))
        if (unknown.length > 0) {
          return {
            title: "Unknown batch",
            output: `Not in ${BATCHES_FILE}: ${unknown.join(", ")}\n\nKnown batches:\n  ${batches.map((b) => b.id).join("\n  ")}`,
          }
        }

        const missing: string[] = []
        for (const id of requested) {
          for (const file of known.get(id)!.mutate) {
            if (!existsSync(path.join(kitRoot, ...file.split("/")))) missing.push(file)
          }
        }
        if (missing.length > 0) {
          return { title: "Missing files", output: `The batch list points at files that do not exist:\n  ${missing.join("\n  ")}` }
        }

        const results: string[] = []
        for (const id of requested) {
          const batch = known.get(id)!
          results.push(`Running ${id} over ${batch.mutate.length} files`)
          const outcome = await runCommand(kitRoot, "npx", [
            "stryker",
            "run",
            "--mutate",
            batch.mutate.join(","),
            "--reporters",
            "clear-text,json,html",
          ])
          if (outcome.code !== 0) {
            const tail = outcome.stderr.trim().split("\n").slice(-8).join("\n")
            return {
              title: `Mutation failed for ${id}`,
              output: `exit code ${outcome.code}\n${tail || outcome.stdout.trim().split("\n").slice(-8).join("\n")}`,
              metadata: { batch: id, code: outcome.code },
            }
          }
          const target = reportPathFor(kitRoot, id)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(path.join(kitRoot, "reports", "mutation", "mutation.json"), target)
          results.push(`  stored ${path.relative(kitRoot, target)}`)
        }
        return {
          title: `Measured ${requested.length} batch(es)`,
          output: results.join("\n"),
          metadata: { batches: requested },
        }
      }

      if (subcommand === "aggregate") {
        const pairs: Array<{ reportPath: string; label: string }> = []
        for (const batch of batches) {
          const reportPath = reportPathFor(kitRoot, batch.id)
          if (existsSync(reportPath)) pairs.push({ reportPath, label: batch.id })
        }
        if (pairs.length === 0) {
          return {
            title: "Nothing to aggregate",
            output: `No stored report under ${REPORTS_DIR}. Run a batch first.`,
          }
        }
        const flat = pairs.flatMap((pair) => [pair.reportPath, pair.label])
        const outcome = await runCommand(kitRoot, process.execPath, [path.join(kitRoot, SCORE_SCRIPT), ...flat])
        if (outcome.code !== 0) {
          return { title: "Aggregate failed", output: outcome.stderr.trim() || outcome.stdout.trim() }
        }
        const measured = pairs.length
        const pending = batches.length - measured
        const footer = pending > 0 ? `\n${pending} batch(es) still pending` : ""
        return {
          title: `Mutation score over ${measured} batch(es)`,
          output: outcome.stdout.trim() + footer,
          metadata: { measured, pending },
        }
      }

      return {
        title: "Error",
        output: `Unknown subcommand '${subcommand}'  Use 'list', 'run <batch...>' or 'aggregate'`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { title: "Error", output: `mutation: ${message}` }
    }
  },
})

export { findKitRoot, readBatches, reportPathFor, countLines }
