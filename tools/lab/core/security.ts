import type { SandboxProviderId } from "./types"

// Records whether a provider can stop the code it runs, so the threat model stays explicit instead of implied.
export type LabIsolationTrust = "kernel-enforced" | "process-level"

export const ISOLATION_TRUST: Record<SandboxProviderId, LabIsolationTrust> = {
  worktree: "process-level",
  "os-sandbox": "kernel-enforced",
  container: "kernel-enforced",
  vm: "kernel-enforced",
}

export const NOEXEC_ADAPTER_HINTS = ["sudo", "docker", "firejail", "bubblewrap", "systemd-nspawn"]

// Answers whether the command line tries to run a mandatory process supervision escalation.
export function needsNoexecAdapter(commandLine: string): boolean {
  return NOEXEC_ADAPTER_HINTS.some((hint) => commandLine.toLowerCase().includes(hint))
}

// Spells out the guardrails a sandbox run promises, which docs and future providers consult together.
export const DEFAULT_SANDBOX_CONTROLS = {
  denyNetwork: true,
  denySudo: true,
  denyTime: false,
  denyHostNetwork: false,
} as const

export type DisablePackageScriptsMode = "off" | "force"

// The lab installs with lifecycle scripts disabled because a lockfile alone does not prove them safe.
export const DEFAULT_PACKAGE_SCRIPT_MODE: DisablePackageScriptsMode = "force"

// Ends with the suffixes that name secrets, so an inherited or logged variable gets flagged.
export function isDenylistedEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase().replace(/[-\s]/g, "_")
  if (normalized.startsWith("AWS_") || normalized.startsWith("GITHUB_TOKEN") || normalized.startsWith("GH_")) return true
  return (
    normalized.endsWith("TOKEN") ||
    normalized.endsWith("_KEY") ||
    normalized.endsWith("SECRET") ||
    normalized.endsWith("PASSWORD") ||
    normalized.endsWith("PASSWD") ||
    normalized.includes("COOKIE")
  )
}

export function denylistedEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => isDenylistedEnvironmentKey(key))
}
