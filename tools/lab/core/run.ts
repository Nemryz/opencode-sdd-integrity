import fs from "node:fs/promises"
import path from "node:path"
import type {
  LabAdapter,
  LabCoverageSummary,
  LabRunSummary,
  LabSandbox,
  LabSelection,
  LabStep,
  LabStepResult,
} from "./types"
import { ensureDependencies } from "./dependencies"
import { ensureRunDir, makeRunId, writeRunSummary } from "./registry"
import { runLabProcess } from "./runner"
import {
  aggregateTotals,
  emptyTotals,
  failureLines,
  formatDuration,
  outputTail,
  parseCoverageSummary,
  parseVitestReport,
  stripAnsi,
} from "./report"

export interface RunLabOptions {
  projectRoot: string
  sandbox: LabSandbox
  adapter: LabAdapter
  selection: LabSelection
  confirmed?: boolean
  signal?: AbortSignal
}

function validateSelection(adapter: LabAdapter, selection: LabSelection): void {
  if (selection.category && selection.profile) {
    throw new Error("Choose a category or a profile, not both")
  }
  if (selection.category && !adapter.categories[selection.category]) {
    throw new Error(
      `Unknown category: ${selection.category}. Known categories: ${Object.keys(adapter.categories).join(", ")}`,
    )
  }
  if (selection.profile && !adapter.profiles[selection.profile]) {
    throw new Error(
      `Unknown profile: ${selection.profile}. Known profiles: ${Object.keys(adapter.profiles).join(", ")}`,
    )
  }
  if (!selection.category && !selection.profile) {
    throw new Error("Choose a category or a profile")
  }
}

async function writeStepLog(file: string, step: LabStep, result: Awaited<ReturnType<typeof runLabProcess>>): Promise<void> {
  const body = [
    `$ ${step.command} ${step.args.join(" ")}`,
    `exit code: ${result.code}`,
    `duration: ${formatDuration(result.durationMs)}`,
    `timed out: ${result.timedOut}`,
    `aborted: ${result.aborted}`,
    "",
    "--- stdout ---",
    stripAnsi(result.stdout),
    "--- stderr ---",
    stripAnsi(result.stderr),
    "",
  ].join("\n")
  await fs.writeFile(file, body, "utf-8")
}

export async function runLab(options: RunLabOptions): Promise<LabRunSummary> {
  const { adapter, sandbox, selection } = options
  validateSelection(adapter, selection)

  const runId = makeRunId()
  const reportDir = await ensureRunDir(options.projectRoot, sandbox.id, runId)
  const steps = adapter.plan(selection, { sandboxRoot: sandbox.sandboxRoot, reportDir })
  if (steps.length === 0) throw new Error("The selected lab profile has no steps")
  if (steps.some((step) => step.requiresConfirmation) && !options.confirmed) {
    throw new Error("This run is heavy or touches an external system; re-run with confirmed: true after asking the user")
  }

  const startedAt = new Date().toISOString()
  const started = Date.now()
  const dependency = await ensureDependencies({
    projectRoot: options.projectRoot,
    sandbox,
    reportDir,
  })
  const results: LabStepResult[] = []
  const notes: string[] = dependency.note ? [dependency.note] : []

  for (const [index, step] of steps.entries()) {
    const stepStarted = Date.now()
    const logPath = path.join(reportDir, `step-${index + 1}.log`)
    const result = await runLabProcess(step.command, step.args, {
      cwd: sandbox.sandboxRoot,
      timeoutMs: step.timeoutMs ?? 15 * 60 * 1000,
      signal: options.signal,
      env: {
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        OPENCODE_LAB: "1",
      },
    })
    await writeStepLog(logPath, step, result)

    const tests = step.reportFile ? await parseVitestReport(step.reportFile) : null
    const coverage = step.coverageFile ? await parseCoverageSummary(step.coverageFile) : null
    if (step.coverageFile && !coverage) {
      notes.push(`Coverage summary was not written at ${step.coverageFile}`)
    }

    const failed = result.code !== 0 || result.timedOut || result.aborted
    const status: LabStepResult["status"] = failed ? "failed" : "passed"
    const combined = `${result.stdout}\n${result.stderr}`
    const stepResult: LabStepResult = {
      label: step.label,
      command: step.command,
      args: step.args,
      code: result.code,
      status,
      durationMs: Date.now() - stepStarted,
      timedOut: result.timedOut,
      truncated: result.truncated,
      logPath,
      outputTail: outputTail(combined),
      tests: tests ?? undefined,
      coverage: coverage ?? undefined,
    }
    results.push(stepResult)

    if (failed) {
      if (result.timedOut) notes.push(`${step.label} timed out after ${formatDuration(stepResult.durationMs)}`)
      if (result.aborted) notes.push(`${step.label} was aborted`)
      const failures = failureLines(combined)
      if (failures.length > 0) notes.push(`${step.label}: ${failures.join(" | ")}`)
      if (!step.optional) {
        notes.push(`Stopped after ${step.label} because the step failed`)
        break
      }
    }
  }

  const finishedAt = new Date().toISOString()
  const requiredFailures = results.filter((result, index) => {
    const step = steps[index]
    return result.status === "failed" && !step?.optional
  })
  const status: LabRunSummary["status"] = requiredFailures.length > 0 ? "failed" : "passed"
  const coverage = results.map((result) => result.coverage).find((value): value is LabCoverageSummary => Boolean(value)) ?? null
  const totals = results.some((result) => result.tests) ? aggregateTotals(results) : emptyTotals()
  const summary: LabRunSummary = {
    version: 1,
    runId,
    sandboxId: sandbox.id,
    adapter: adapter.id,
    selection,
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    status,
    steps: results,
    totals,
    coverage,
    notes,
    summaryPath: path.join(reportDir, "summary.json"),
  }
  await writeRunSummary(options.projectRoot, summary)
  return summary
}
