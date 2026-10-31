import fs from "node:fs/promises"
import path from "node:path"
import type {
  LabFlakeAttempt,
  LabFlakeResult,
  LabRunSummary,
  LabStep,
  LabStepResult,
  LabTestTotals,
} from "./types"
import { runLabProcess } from "./runner"
import { outputTail, parseVitestReport, stripAnsi } from "./report"
import { writeTextAtomic } from "./fs"

const FLAKE_FILE_LIMIT = 10

function uniqueFiles(failures: Array<{ name: string; file: string }>): string[] {
  const files = [...new Set(failures.map((failure) => failure.file).filter((file) => file && file !== "unknown"))]
  return files.slice(0, FLAKE_FILE_LIMIT)
}

async function writeProcessLog(file: string, label: string, command: string, args: string[], result: Awaited<ReturnType<typeof runLabProcess>>): Promise<void> {
  const body = [
    `$ ${command} ${args.join(" ")}`,
    `exit code: ${result.code}`,
    `duration: ${result.durationMs}ms`,
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

export async function detectFlake(options: {
  step: LabStep
  result: LabStepResult
  sandbox: { sandboxRoot: string }
  reportDir: string
  runProcess?: typeof runLabProcess
}): Promise<LabFlakeResult | null> {
  const run = options.runProcess ?? runLabProcess
  const failures = options.result.tests?.failures ?? []
  if (!options.step.rerun || failures.length === 0) return null

  const failedTests = [...failures]
  const files = uniqueFiles(failures)
  if (files.length === 0) {
    return {
      classification: "inconclusive",
      failedTests,
      attempts: [],
      seeds: [],
      notes: ["No failed test file could be extracted from the Vitest report"],
    }
  }

  const attempts: LabFlakeAttempt[] = []
  const seeds: string[] = []
  const notes: string[] = []
  if (failures.length > files.length) notes.push(`Flake detection limited to the first ${FLAKE_FILE_LIMIT} failed files`)

  const sameSeed = options.step.seed
  if (sameSeed) seeds.push(sameSeed)
  const samePlan = options.step.rerun({ files, seed: sameSeed, attempt: 1, kind: "same" })
  const sameLog = path.join(options.reportDir, `${samePlan.label}.log`)
  const sameResult = await run(samePlan.command, samePlan.args, {
    cwd: options.sandbox.sandboxRoot,
    timeoutMs: samePlan.timeoutMs ?? 10 * 60 * 1000,
    env: { NO_COLOR: "1", FORCE_COLOR: "0", OPENCODE_LAB: "1" },
  })
  await writeProcessLog(sameLog, samePlan.label, samePlan.command, samePlan.args, sameResult)
  const sameReport = samePlan.reportFile ? await parseVitestReport(samePlan.reportFile) : null
  const sameFailed = sameReport?.failures ?? []
  const sameAttempt: LabFlakeAttempt = {
    kind: "same",
    attempt: 1,
    seed: sameSeed,
    files,
    status: sameResult.code === 0 && sameFailed.length === 0 ? "passed" : "failed",
    failed: sameFailed,
    durationMs: sameResult.durationMs,
    logPath: sameLog,
    outputTail: outputTail(`${sameResult.stdout}\n${sameResult.stderr}`),
  }
  attempts.push(sameAttempt)

  if (sameAttempt.status === "failed" || !sameReport) {
    if (!sameReport) notes.push("The same-seed rerun did not produce a readable Vitest report")
    return {
      classification: "real",
      failedTests,
      attempts,
      seeds,
      notes,
    }
  }

  const shuffledSeed = sameSeed ? String(Number(sameSeed) + 1) : "20261031"
  seeds.push(shuffledSeed)
  const shuffledPlan = options.step.rerun({ files, seed: shuffledSeed, attempt: 2, kind: "shuffled" })
  const shuffledLog = path.join(options.reportDir, `${shuffledPlan.label}.log`)
  const shuffledResult = await run(shuffledPlan.command, shuffledPlan.args, {
    cwd: options.sandbox.sandboxRoot,
    timeoutMs: shuffledPlan.timeoutMs ?? 10 * 60 * 1000,
    env: { NO_COLOR: "1", FORCE_COLOR: "0", OPENCODE_LAB: "1" },
  })
  await writeProcessLog(shuffledLog, shuffledPlan.label, shuffledPlan.command, shuffledPlan.args, shuffledResult)
  const shuffledReport = shuffledPlan.reportFile ? await parseVitestReport(shuffledPlan.reportFile) : null
  const shuffledFailed = shuffledReport?.failures ?? []
  const shuffledAttempt: LabFlakeAttempt = {
    kind: "shuffled",
    attempt: 2,
    seed: shuffledSeed,
    files,
    status: shuffledResult.code === 0 && shuffledFailed.length === 0 ? "passed" : "failed",
    failed: shuffledFailed,
    durationMs: shuffledResult.durationMs,
    logPath: shuffledLog,
    outputTail: outputTail(`${shuffledResult.stdout}\n${shuffledResult.stderr}`),
  }
  attempts.push(shuffledAttempt)

  if (shuffledAttempt.status === "failed" || !shuffledReport) {
    if (!shuffledReport) notes.push("The shuffled rerun did not produce a readable Vitest report")
    return {
      classification: "order-dependent",
      failedTests,
      attempts,
      seeds,
      notes,
    }
  }

  return {
    classification: "flaky",
    failedTests,
    attempts,
    seeds,
    notes,
  }
}

export function formatFlakeReport(flakes: LabFlakeResult[]): string {
  const lines = ["Lab flakes", ""]
  for (const flake of flakes) {
    lines.push(`${flake.classification}: ${flake.failedTests.length} test(s)`)
    for (const attempt of flake.attempts) {
      lines.push(`  ${attempt.kind} seed ${attempt.seed ?? "unseeded"}: ${attempt.status} in ${attempt.durationMs}ms`)
    }
    if (flake.notes.length > 0) lines.push(...flake.notes.map((note) => `  note: ${note}`))
  }
  return lines.join("\n")
}

export function flakeMarkdown(flakes: LabFlakeResult[]): string {
  const lines = ["# Lab Flake Report", ""]
  for (const flake of flakes) {
    lines.push(`## ${flake.classification}`)
    lines.push("")
    lines.push(`Failed tests: ${flake.failedTests.length}`)
    lines.push("")
    lines.push("| Attempt | Kind | Seed | Status | Duration ms |")
    lines.push("|---|---|---|---|---:|")
    for (const attempt of flake.attempts) {
      lines.push(`| ${attempt.attempt} | ${attempt.kind} | ${attempt.seed ?? "unseeded"} | ${attempt.status} | ${attempt.durationMs} |`)
    }
    lines.push("")
    if (flake.notes.length > 0) {
      lines.push("Notes:")
      lines.push(...flake.notes.map((note) => `- ${note}`))
      lines.push("")
    }
  }
  return lines.join("\n")
}
