// Shared contracts for the isolated test lab. The core knows nothing about SDD state.

export interface LabCategory {
  description: string
  paths: string[]
}

export interface LabSelection {
  category?: string
  profile?: string
}

export interface LabPlanContext {
  sandboxRoot: string
  reportDir: string
}

export interface LabRerunContext {
  files: string[]
  seed?: string
  attempt: number
  kind: "same" | "shuffled"
}

export interface LabRerunPlan {
  label: string
  command: string
  args: string[]
  timeoutMs?: number
  reportFile?: string
  seed?: string
}

export interface LabStep {
  label: string
  command: string
  args: string[]
  timeoutMs?: number
  reportFile?: string
  coverageFile?: string
  optional?: boolean
  requiresConfirmation?: boolean
  continueOnFailure?: boolean
  seed?: string
  rerun?: (context: LabRerunContext) => LabRerunPlan
}

export interface LabProfile {
  description: string
}

export interface LabAdapter {
  id: string
  description: string
  categories: Record<string, LabCategory>
  profiles: Record<string, LabProfile>
  defaultExclude: string[]
  plan(selection: LabSelection, context: LabPlanContext): LabStep[]
}

export type LabSandboxStatus = "active" | "promoted" | "destroyed"

export type LabPackageManager = "npm" | "pnpm" | "yarn" | "bun"

export interface LabDependencyState {
  strategy: "linked" | "pending" | "installed" | "missing"
  lockfile?: string
  lockHash?: string
  sourceLockfile?: string
  sourceLockHash?: string
  manager?: LabPackageManager
  logPath?: string
  updatedAt?: string
}

export interface LabSandbox {
  id: string
  projectRoot: string
  repoRoot: string
  sandboxRoot: string
  adapter: string
  label?: string
  baseCommit: string
  createdAt: string
  status: LabSandboxStatus
  warnings: string[]
  dependencies?: LabDependencyState
  lastDiffAt?: string
  lastDiffHash?: string
  lastDiffPath?: string
  promotedAt?: string
  promotedHead?: string
  promotedPatchHash?: string
  lastRunAt?: string
  lastRunStatus?: string
  lastRunId?: string
}

export interface LabRegistry {
  version: 1
  sandboxes: LabSandbox[]
}

export interface LabTestTotals {
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  slowest: Array<{ name: string; durationMs: number }>
  failures?: Array<{ name: string; file: string }>
}

export interface LabCoverageTotals {
  lines: number
  branches: number
  functions: number
  statements: number
}

export interface LabCoverageSummary {
  totals: LabCoverageTotals
  lowest: Array<{ file: string; lines: number }>
}

export interface LabStepResult {
  label: string
  command: string
  args: string[]
  code: number
  status: "passed" | "failed" | "skipped"
  durationMs: number
  timedOut: boolean
  truncated: boolean
  logPath: string
  outputTail: string
  seed?: string
  tests?: LabTestTotals
  coverage?: LabCoverageSummary
  flake?: LabFlakeResult
}

export interface LabFlakeAttempt {
  kind: "same" | "shuffled"
  attempt: number
  seed?: string
  files: string[]
  status: "passed" | "failed"
  failed: Array<{ name: string; file: string }>
  durationMs: number
  logPath: string
  outputTail: string
}

export interface LabFlakeResult {
  classification: "real" | "flaky" | "order-dependent" | "inconclusive"
  failedTests: Array<{ name: string; file: string }>
  attempts: LabFlakeAttempt[]
  seeds: string[]
  notes: string[]
}

export interface LabRunSummary {
  version: 1
  runId: string
  sandboxId: string
  adapter: string
  commit?: string
  selection: LabSelection
  startedAt: string
  finishedAt: string
  durationMs: number
  status: "passed" | "failed" | "error"
  steps: LabStepResult[]
  totals: LabTestTotals
  coverage: LabCoverageSummary | null
  notes: string[]
  flakes?: LabFlakeResult[]
  flakePath?: string
  summaryPath: string
}
