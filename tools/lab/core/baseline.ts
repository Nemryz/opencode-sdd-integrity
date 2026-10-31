import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type {
  LabCoverageSummary,
  LabRunSummary,
  LabSelection,
  LabTestTotals,
} from "./types"
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fs"

export interface LabBaselineOptions {
  durationTolerancePct?: number
  coverageTolerancePct?: number
  slowTestTolerancePct?: number
  slowTestFloorMs?: number
}

export const DEFAULT_BASELINE_OPTIONS: Required<LabBaselineOptions> = {
  durationTolerancePct: 25,
  coverageTolerancePct: 0.5,
  slowTestTolerancePct: 50,
  slowTestFloorMs: 100,
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default"
}

export interface LabBaseline {
  version: 1
  adapter: string
  selection: LabSelection
  commit: string
  sandboxId: string
  runId: string
  createdAt: string
  platform: string
  node: string
  status: LabRunSummary["status"]
  durationMs: number
  totals: LabTestTotals
  coverage: LabCoverageSummary | null
  steps: Array<{
    label: string
    status: "passed" | "failed" | "skipped"
    durationMs: number
    tests?: LabTestTotals
    coverage?: LabCoverageSummary
  }>
}

export interface LabComparison {
  version: 1
  adapter: string
  selection: LabSelection
  baseline: { runId: string; sandboxId: string; commit: string; createdAt: string }
  current: { runId: string; sandboxId: string; commit: string; finishedAt: string }
  status: "pass" | "regressed"
  metrics: {
    total: { baseline: number; current: number; delta: number }
    passed: { baseline: number; current: number; delta: number }
    failed: { baseline: number; current: number; delta: number }
    skipped: { baseline: number; current: number; delta: number }
    durationMs: { baseline: number; current: number; delta: number }
    coverage: {
      lines: { baseline: number; current: number; delta: number }
      branches: { baseline: number; current: number; delta: number }
      functions: { baseline: number; current: number; delta: number }
      statements: { baseline: number; current: number; delta: number }
    }
  }
  regressions: string[]
  warnings: string[]
  improvements: string[]
  slowest: Array<{ name: string; baselineMs: number; currentMs: number; deltaPct: number }>
  failureDelta: { added: string[]; fixed: string[] }
}

export function selectionKey(selection: LabSelection): string {
  if (selection.category) return `category-${safeSegment(selection.category)}`
  if (selection.profile) return `profile-${safeSegment(selection.profile)}`
  throw new Error("A baseline requires a category or a profile")
}

export function baselinePath(projectRoot: string, adapter: string, selection: LabSelection): string {
  return path.join(projectRoot, "reports", "lab", "baselines", safeSegment(adapter), `${selectionKey(selection)}.json`)
}

export async function readBaseline(projectRoot: string, adapter: string, selection: LabSelection): Promise<LabBaseline | null> {
  return readJson<LabBaseline>(baselinePath(projectRoot, adapter, selection))
}

export async function writeBaseline(projectRoot: string, baseline: LabBaseline): Promise<string> {
  const file = baselinePath(projectRoot, baseline.adapter, baseline.selection)
  await writeJsonAtomic(file, baseline)
  return file
}

export function createBaseline(summary: LabRunSummary, commit: string): LabBaseline {
  return {
    version: 1,
    adapter: summary.adapter,
    selection: summary.selection,
    commit,
    sandboxId: summary.sandboxId,
    runId: summary.runId,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    status: summary.status,
    durationMs: summary.durationMs,
    totals: summary.totals,
    coverage: summary.coverage,
    steps: summary.steps.map((step) => ({
      label: step.label,
      status: step.status,
      durationMs: step.durationMs,
      tests: step.tests,
      coverage: step.coverage,
    })),
  }
}

function delta(current: number, baseline: number): { baseline: number; current: number; delta: number } {
  return { baseline, current, delta: current - baseline }
}

function failureKey(failure: { name: string; file: string }): string {
  return `${failure.file} :: ${failure.name}`
}

function metricRegressions(current: LabCoverageSummary | null, baseline: LabCoverageSummary | null, tolerance: number, regressions: string[]): void {
  if (!current || !baseline) return
  const pairs: Array<[string, number, number]> = [
    ["lines", current.totals.lines, baseline.totals.lines],
    ["branches", current.totals.branches, baseline.totals.branches],
    ["functions", current.totals.functions, baseline.totals.functions],
    ["statements", current.totals.statements, baseline.totals.statements],
  ]
  for (const [name, currentValue, baselineValue] of pairs) {
    if (currentValue < baselineValue - tolerance) {
      regressions.push(`coverage ${name} dropped from ${baselineValue}% to ${currentValue}%`)
    }
  }
}

export function compareRunToBaseline(
  current: LabRunSummary,
  baseline: LabBaseline,
  options: LabBaselineOptions = {},
): LabComparison {
  const opts = { ...DEFAULT_BASELINE_OPTIONS, ...options }
  const regressions: string[] = []
  const warnings: string[] = []
  const improvements: string[] = []

  if (current.adapter !== baseline.adapter) throw new Error("Baseline adapter does not match the current run")
  if (JSON.stringify(current.selection) !== JSON.stringify(baseline.selection)) throw new Error("Baseline selection does not match the current run")

  const currentFailures = new Set((current.totals.failures ?? []).map(failureKey))
  const baselineFailures = new Set((baseline.totals.failures ?? []).map(failureKey))
  const addedFailures = [...currentFailures].filter((value) => !baselineFailures.has(value))
  const fixedFailures = [...baselineFailures].filter((value) => !currentFailures.has(value))

  if (baseline.status !== "passed") warnings.push(`Baseline run status was ${baseline.status}, not passed`)
  if (current.status === "failed" && baseline.status === "passed") regressions.push("run status changed from passed to failed")
  if (current.totals.failed > baseline.totals.failed) regressions.push(`failed tests increased from ${baseline.totals.failed} to ${current.totals.failed}`)
  if (addedFailures.length > 0) regressions.push(`new failing tests: ${addedFailures.join(", ")}`)
  if (current.totals.skipped > baseline.totals.skipped) regressions.push(`skipped tests increased from ${baseline.totals.skipped} to ${current.totals.skipped}`)
  if (current.totals.total < baseline.totals.total) regressions.push(`test count dropped from ${baseline.totals.total} to ${current.totals.total}`)
  if (current.totals.passed < baseline.totals.passed && current.totals.total >= baseline.totals.total) regressions.push(`passed tests dropped from ${baseline.totals.passed} to ${current.totals.passed}`)
  metricRegressions(current.coverage, baseline.coverage, opts.coverageTolerancePct, regressions)

  for (const baselineStep of baseline.steps) {
    const currentStep = current.steps.find((step) => step.label === baselineStep.label)
    if (!currentStep) {
      warnings.push(`step ${baselineStep.label} is missing from the current run`)
      continue
    }
    if (baselineStep.status === "passed" && currentStep.status === "failed") {
      regressions.push(`step ${baselineStep.label} changed from passed to failed`)
    }
  }
  for (const currentStep of current.steps) {
    if (!baseline.steps.some((step) => step.label === currentStep.label)) warnings.push(`new step ${currentStep.label} appeared in the current run`)
  }

  if (current.commit && baseline.commit && current.commit !== baseline.commit) warnings.push(`baseline was measured on ${baseline.commit.slice(0, 12)}, current run is on ${current.commit.slice(0, 12)}`)
  if (process.platform !== baseline.platform) warnings.push(`baseline platform ${baseline.platform} differs from current platform ${process.platform}`)
  if (baseline.durationMs > 0 && current.durationMs > baseline.durationMs * (1 + opts.durationTolerancePct / 100)) {
    warnings.push(`duration increased from ${baseline.durationMs}ms to ${current.durationMs}ms`)
  }

  const slowest: LabComparison["slowest"] = []
  const baselineSlowest = new Map((baseline.totals.slowest ?? []).map((entry: { name: string; durationMs: number }) => [entry.name, entry.durationMs]))
  for (const entry of current.totals.slowest ?? []) {
    const baselineMs = baselineSlowest.get(entry.name)
    if (baselineMs === undefined) {
      warnings.push(`new slow test: ${entry.name} at ${entry.durationMs}ms`)
      slowest.push({ name: entry.name, baselineMs: 0, currentMs: entry.durationMs, deltaPct: 100 })
      continue
    }
    const deltaPct = baselineMs > 0 ? Math.round(((entry.durationMs - baselineMs) / baselineMs) * 100) : 0
    slowest.push({ name: entry.name, baselineMs, currentMs: entry.durationMs, deltaPct })
    if (baselineMs > 0 && entry.durationMs > baselineMs * (1 + opts.slowTestTolerancePct / 100) && entry.durationMs > opts.slowTestFloorMs) {
      warnings.push(`slow test ${entry.name} increased from ${baselineMs}ms to ${entry.durationMs}ms`)
    }
  }

  if (current.totals.failed < baseline.totals.failed) improvements.push(`failed tests decreased from ${baseline.totals.failed} to ${current.totals.failed}`)
  if (fixedFailures.length > 0) improvements.push(`fixed failing tests: ${fixedFailures.join(", ")}`)
  if (current.totals.skipped < baseline.totals.skipped) improvements.push(`skipped tests decreased from ${baseline.totals.skipped} to ${current.totals.skipped}`)
  if (current.totals.total > baseline.totals.total) improvements.push(`test count increased from ${baseline.totals.total} to ${current.totals.total}`)
  if (current.totals.passed > baseline.totals.passed) improvements.push(`passed tests increased from ${baseline.totals.passed} to ${current.totals.passed}`)
  if (current.durationMs < baseline.durationMs) improvements.push(`duration decreased from ${baseline.durationMs}ms to ${current.durationMs}ms`)
  if (current.coverage && baseline.coverage) {
    if (current.coverage.totals.lines > baseline.coverage.totals.lines) improvements.push(`line coverage increased from ${baseline.coverage.totals.lines}% to ${current.coverage.totals.lines}%`)
    if (current.coverage.totals.branches > baseline.coverage.totals.branches) improvements.push(`branch coverage increased from ${baseline.coverage.totals.branches}% to ${current.coverage.totals.branches}%`)
  }
  if (current.status === "passed" && baseline.status !== "passed") improvements.push(`run status improved from ${baseline.status} to passed`)

  return {
    version: 1,
    adapter: current.adapter,
    selection: current.selection,
    baseline: {
      runId: baseline.runId,
      sandboxId: baseline.sandboxId,
      commit: baseline.commit,
      createdAt: baseline.createdAt,
    },
    current: {
      runId: current.runId,
      sandboxId: current.sandboxId,
      commit: current.commit ?? "",
      finishedAt: current.finishedAt,
    },
    status: regressions.length > 0 ? "regressed" : "pass",
    metrics: {
      total: delta(current.totals.total, baseline.totals.total),
      passed: delta(current.totals.passed, baseline.totals.passed),
      failed: delta(current.totals.failed, baseline.totals.failed),
      skipped: delta(current.totals.skipped, baseline.totals.skipped),
      durationMs: delta(current.durationMs, baseline.durationMs),
      coverage: {
        lines: delta(current.coverage?.totals.lines ?? 0, baseline.coverage?.totals.lines ?? 0),
        branches: delta(current.coverage?.totals.branches ?? 0, baseline.coverage?.totals.branches ?? 0),
        functions: delta(current.coverage?.totals.functions ?? 0, baseline.coverage?.totals.functions ?? 0),
        statements: delta(current.coverage?.totals.statements ?? 0, baseline.coverage?.totals.statements ?? 0),
      },
    },
    regressions,
    warnings,
    improvements,
    slowest,
    failureDelta: { added: addedFailures, fixed: fixedFailures },
  }
}

export function formatComparison(comparison: LabComparison): string {
  const lines = [
    `${comparison.status === "pass" ? "PASS" : "REGRESSED"} ${comparison.selection.profile ? `profile ${comparison.selection.profile}` : `category ${comparison.selection.category ?? "all"}`}`,
    `  baseline: ${comparison.baseline.runId} on ${comparison.baseline.commit.slice(0, 12)} (${comparison.baseline.createdAt})`,
    `  current:  ${comparison.current.runId} on ${comparison.current.commit.slice(0, 12)} (${comparison.current.finishedAt})`,
    `  tests: ${comparison.metrics.passed.current}/${comparison.metrics.total.current} passed, ${comparison.metrics.failed.current} failed, ${comparison.metrics.skipped.current} skipped`,
  ]
  if (comparison.regressions.length > 0) {
    lines.push("  regressions:")
    lines.push(...comparison.regressions.map((entry: string) => `    - ${entry}`))
  }
  if (comparison.warnings.length > 0) {
    lines.push("  warnings:")
    lines.push(...comparison.warnings.map((entry: string) => `    - ${entry}`))
  }
  if (comparison.improvements.length > 0) {
    lines.push("  improvements:")
    lines.push(...comparison.improvements.map((entry: string) => `    - ${entry}`))
  }
  return lines.join("\n")
}

export function comparisonMarkdown(comparison: LabComparison): string {
  const lines = [
    "# Lab Baseline Comparison",
    "",
    `Status: **${comparison.status}**`,
    "",
    `Selection: ${comparison.selection.profile ? `profile ${comparison.selection.profile}` : `category ${comparison.selection.category ?? "all"}`}`,
    "",
    "## Runs",
    "",
    "| Run | Commit | Created |",
    "|---|---|---|",
    `| Baseline ${comparison.baseline.runId} | ${comparison.baseline.commit} | ${comparison.baseline.createdAt} |`,
    `| Current ${comparison.current.runId} | ${comparison.current.commit} | ${comparison.current.finishedAt} |`,
    "",
    "## Metrics",
    "",
    "| Metric | Baseline | Current | Delta |",
    "|---|---:|---:|---:|",
    `| Total | ${comparison.metrics.total.baseline} | ${comparison.metrics.total.current} | ${comparison.metrics.total.delta} |`,
    `| Passed | ${comparison.metrics.passed.baseline} | ${comparison.metrics.passed.current} | ${comparison.metrics.passed.delta} |`,
    `| Failed | ${comparison.metrics.failed.baseline} | ${comparison.metrics.failed.current} | ${comparison.metrics.failed.delta} |`,
    `| Skipped | ${comparison.metrics.skipped.baseline} | ${comparison.metrics.skipped.current} | ${comparison.metrics.skipped.delta} |`,
    `| Duration ms | ${comparison.metrics.durationMs.baseline} | ${comparison.metrics.durationMs.current} | ${comparison.metrics.durationMs.delta} |`,
    "",
    "## Regressions",
    "",
  ]
  lines.push(...(comparison.regressions.length > 0 ? comparison.regressions.map((entry: string) => `- ${entry}`) : ["- none"]))
  lines.push("", "## Warnings", "")
  lines.push(...(comparison.warnings.length > 0 ? comparison.warnings.map((entry: string) => `- ${entry}`) : ["- none"]))
  lines.push("", "## Improvements", "")
  lines.push(...(comparison.improvements.length > 0 ? comparison.improvements.map((entry: string) => `- ${entry}`) : ["- none"]))
  lines.push("")
  return lines.join("\n")
}

export function comparisonPath(projectRoot: string, sandboxId: string, runId: string): string {
  return path.join(projectRoot, "reports", "lab", sandboxId, "comparisons", `compare-${runId}.json`)
}

export function comparisonMarkdownPath(projectRoot: string, sandboxId: string, runId: string): string {
  return path.join(projectRoot, "reports", "lab", sandboxId, "comparisons", `compare-${runId}.md`)
}
