import fs from "node:fs/promises"
import type {
  LabCoverageSummary,
  LabCoverageTotals,
  LabRunSummary,
  LabStepResult,
  LabTestTotals,
} from "./types"

interface VitestAssertion {
  title?: string
  fullName?: string
  status?: string
  duration?: number
}

interface VitestFile {
  name?: string
  status?: string
  assertionResults?: VitestAssertion[]
}

interface VitestReport {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
  testResults?: VitestFile[]
}

interface CoverageMetric {
  pct?: number
}

interface CoverageFile {
  lines?: CoverageMetric
  branches?: CoverageMetric
  functions?: CoverageMetric
  statements?: CoverageMetric
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "")
}

export function outputTail(value: string, limit = 8000): string {
  const clean = stripAnsi(value).trim()
  return clean.length <= limit ? clean : `...\n${clean.slice(clean.length - limit)}`
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
}

export async function parseVitestReport(file: string): Promise<LabTestTotals | null> {
  let report: VitestReport
  try {
    report = JSON.parse(await fs.readFile(file, "utf-8")) as VitestReport
  } catch {
    return null
  }

  const assertions = (report.testResults ?? []).flatMap((entry) =>
    (entry.assertionResults ?? []).map((assertion) => ({
      file: entry.name ?? "unknown",
      name: assertion.fullName ?? assertion.title ?? entry.name ?? "unknown test",
      status: assertion.status ?? "unknown",
      durationMs: typeof assertion.duration === "number" ? assertion.duration : 0,
    })),
  )

  const count = (status: string): number => assertions.filter((entry) => entry.status === status).length
  const total = report.numTotalTests ?? assertions.length
  const failed = report.numFailedTests ?? count("failed")
  const countedSkipped = count("pending") + count("skipped") + count("todo")
  const reportedSkipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
  const skipped = reportedSkipped > 0 ? reportedSkipped : countedSkipped
  const passed = report.numPassedTests ?? Math.max(0, total - failed - skipped)
  const durationMs = assertions.reduce((sum, entry) => sum + entry.durationMs, 0)
  const slowest = [...assertions]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map((entry) => ({ name: entry.name, durationMs: Math.round(entry.durationMs) }))

  const failures = assertions
    .filter((entry) => entry.status === "failed")
    .map((entry) => ({ name: entry.name, file: entry.file }))
  const uniqueFailures = [...new Map(failures.map((entry) => [`${entry.file} :: ${entry.name}`, entry])).values()]

  return { total, passed, failed, skipped, durationMs: Math.round(durationMs), slowest, failures: uniqueFailures }
}

function metricPct(metric: CoverageMetric | undefined): number {
  return typeof metric?.pct === "number" ? metric.pct : 0
}

export async function parseCoverageSummary(file: string): Promise<LabCoverageSummary | null> {
  let summary: Record<string, CoverageFile>
  try {
    summary = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, CoverageFile>
  } catch {
    return null
  }
  const total = summary.total
  if (!total) return null

  const totals: LabCoverageTotals = {
    lines: metricPct(total.lines),
    branches: metricPct(total.branches),
    functions: metricPct(total.functions),
    statements: metricPct(total.statements),
  }
  const lowest = Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, value]) => ({ file, lines: metricPct(value.lines) }))
    .sort((a, b) => a.lines - b.lines)
    .slice(0, 5)

  return { totals, lowest }
}

export function emptyTotals(): LabTestTotals {
  return { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, slowest: [], failures: [] }
}

export function aggregateTotals(steps: LabStepResult[]): LabTestTotals {
  const totals = emptyTotals()
  for (const step of steps) {
    if (!step.tests) continue
    totals.total += step.tests.total
    totals.passed += step.tests.passed
    totals.failed += step.tests.failed
    totals.skipped += step.tests.skipped
    totals.durationMs += step.tests.durationMs
    totals.slowest.push(...step.tests.slowest)
  }
  totals.slowest = totals.slowest.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
  const failures = new Map<string, { name: string; file: string }>()
  for (const step of steps) {
    for (const failure of step.tests?.failures ?? []) failures.set(`${failure.file} :: ${failure.name}`, failure)
  }
  totals.failures = [...failures.values()]
  return totals
}

export function failureLines(value: string, limit = 12): string[] {
  return stripAnsi(value)
    .split(/\r?\n/)
    .filter((line) => /\bFAIL\b|\bError\b|AssertionError|expected .* to/.test(line))
    .slice(0, limit)
}

export function formatRunSummary(summary: LabRunSummary): string {
  const lines = [
    `${summary.status.toUpperCase()} ${summary.selection.profile ? `profile ${summary.selection.profile}` : `category ${summary.selection.category ?? "all"}`}`,
    `  run: ${summary.runId}`,
    `  sandbox: ${summary.sandboxId}`,
    `  duration: ${formatDuration(summary.durationMs)}`,
  ]
  if (summary.totals.total > 0) {
    lines.push(
      `  tests: ${summary.totals.passed}/${summary.totals.total} passed, ${summary.totals.failed} failed, ${summary.totals.skipped} skipped`,
    )
  }
  if (summary.coverage) {
    lines.push(
      `  coverage: lines ${summary.coverage.totals.lines}%, branches ${summary.coverage.totals.branches}%, functions ${summary.coverage.totals.functions}%`,
    )
  }
  if (summary.steps.length > 0) {
    lines.push("  steps:")
    for (const step of summary.steps) {
      const extra = step.tests ? ` (${step.tests.passed}/${step.tests.total})` : ""
      lines.push(`    ${step.status.padEnd(7)} ${step.label}${extra} in ${formatDuration(step.durationMs)}`)
    }
  }
  if (summary.flakes && summary.flakes.length > 0) {
    lines.push("  flakes:")
    lines.push(...summary.flakes.map((flake) => `    - ${flake.classification}: ${flake.failedTests.length} test(s)`))
  }
  if (summary.notes.length > 0) {
    lines.push("  notes:")
    lines.push(...summary.notes.map((note) => `    - ${note}`))
  }
  return lines.join("\n")
}
