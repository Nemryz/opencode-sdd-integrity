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
  maxOutputBytes?: number
  limits?: LabStepLimits
  reportFile?: string
  coverageFile?: string
  optional?: boolean
  requiresConfirmation?: boolean
  continueOnFailure?: boolean
  seed?: string
  rerun?: (context: LabRerunContext) => LabRerunPlan
}

// Carries the kernel backed caps a sandbox may enforce on a child when the host exposes them.
export interface LabStepLimits {
  cpuSeconds?: number
  memoryBytes?: number
}

export interface LabProfile {
  description: string
}

export type SandboxProviderId = "worktree" | "os-sandbox" | "container" | "vm"

// Names the isolation layer used by a sandbox in audit events, with n/a for actions outside one.
export type LabIsolationProvider = SandboxProviderId | "n/a"

// Classifies the workload so the policy resolver can pick an isolation level instead of assuming one.
export type SandboxTrust = "trusted" | "suspicious" | "untrusted" | "hostile"

export const SANDBOX_TRUSTS: readonly SandboxTrust[] = ["trusted", "suspicious", "untrusted", "hostile"]

export function isSandboxTrust(value: unknown): value is SandboxTrust {
  return typeof value === "string" && (SANDBOX_TRUSTS as readonly string[]).includes(value)
}

// Network none blocks egress where the provider enforces it and records the intent everywhere else.
export type SandboxNetworkPolicy = "none" | "allowlist"

export const SANDBOX_NETWORK_POLICIES: readonly SandboxNetworkPolicy[] = ["none", "allowlist"]

export function isSandboxNetworkPolicy(value: unknown): value is SandboxNetworkPolicy {
  return typeof value === "string" && (SANDBOX_NETWORK_POLICIES as readonly string[]).includes(value)
}

// Secrets never inherit by default, so an allowlist is the only way a key reaches a lab process.
export type SandboxSecretsPolicy = "none" | "allowlist"

export const SANDBOX_SECRETS_POLICIES: readonly SandboxSecretsPolicy[] = ["none", "allowlist"]

export function isSandboxSecretsPolicy(value: unknown): value is SandboxSecretsPolicy {
  return typeof value === "string" && (SANDBOX_SECRETS_POLICIES as readonly string[]).includes(value)
}

// Carries the resolved execution policy a sandbox records so runs and audits read one source.
export interface SandboxPolicy {
  network: SandboxNetworkPolicy
  networkAllow: string[]
  secrets: SandboxSecretsPolicy
  secretsAllow: string[]
  offline: boolean
  registries: string[]
  containerImage: string
}

export const DEFAULT_CONTAINER_IMAGE = "node:22"

export function defaultSandboxPolicy(): SandboxPolicy {
  return {
    network: "none",
    networkAllow: [],
    secrets: "none",
    secretsAllow: [],
    offline: false,
    registries: [],
    containerImage: DEFAULT_CONTAINER_IMAGE,
  }
}

function stringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Lab sandbox policy ${field} must be a list of non empty strings`)
  }
  return raw as string[]
}

// Validates a stored policy entry field by field so a tampered registry fails loud instead of widening access.
export function sanitizeSandboxPolicy(raw: unknown): SandboxPolicy {
  if (raw === undefined || raw === null) return defaultSandboxPolicy()
  if (typeof raw !== "object") throw new Error("Lab sandbox policy must be an object")
  const value = raw as Record<string, unknown>
  const defaults = defaultSandboxPolicy()
  if (value.network !== undefined && !isSandboxNetworkPolicy(value.network)) {
    throw new Error("Lab sandbox policy network must be none or allowlist")
  }
  if (value.secrets !== undefined && !isSandboxSecretsPolicy(value.secrets)) {
    throw new Error("Lab sandbox policy secrets must be none or allowlist")
  }
  if (value.offline !== undefined && typeof value.offline !== "boolean") {
    throw new Error("Lab sandbox policy offline must be a boolean")
  }
  if (value.containerImage !== undefined && (typeof value.containerImage !== "string" || value.containerImage.trim() === "")) {
    throw new Error("Lab sandbox policy containerImage must be a non empty string")
  }
  return {
    network: isSandboxNetworkPolicy(value.network) ? value.network : defaults.network,
    networkAllow: value.networkAllow === undefined ? defaults.networkAllow : stringList(value.networkAllow, "networkAllow"),
    secrets: isSandboxSecretsPolicy(value.secrets) ? value.secrets : defaults.secrets,
    secretsAllow: value.secretsAllow === undefined ? defaults.secretsAllow : stringList(value.secretsAllow, "secretsAllow"),
    offline: typeof value.offline === "boolean" ? value.offline : defaults.offline,
    registries: value.registries === undefined ? defaults.registries : stringList(value.registries, "registries"),
    containerImage: typeof value.containerImage === "string" && value.containerImage.trim() !== "" ? value.containerImage : defaults.containerImage,
  }
}

// Reports what a provider can do right now so a resolver refuses loudly instead of degrading.
export interface ProviderAvailability {
  available: boolean
  reason: string
}

export interface SandboxProviderContext {
  cwd: string
}

export const WORKTREE_PROVIDER: SandboxProvider = {
  id: "worktree",
  description: "A disposable git worktree for a trusted checkout",
  availability: () => ({ available: true, reason: "git worktrees need no extra tooling" }),
  wrap: (command, args) => ({ command, args }),
}

export interface SandboxProvider {
  id: SandboxProviderId
  description: string
  availability(): ProviderAvailability
  wrap(command: string, args: string[], context: SandboxProviderContext): { command: string; args: string[] }
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
  provider: SandboxProviderId
  trust: SandboxTrust
  policy: SandboxPolicy
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
