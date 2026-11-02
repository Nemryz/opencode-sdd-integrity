import fs from "node:fs/promises"
import path from "node:path"
import { labPaths } from "./home"
import { appendLabAudit } from "./audit"
import type { SandboxNetworkPolicy, SandboxSecretsPolicy } from "./types"
import { isSandboxNetworkPolicy, isSandboxSecretsPolicy } from "./types"

export const LAB_DISABLED_ENV = "OPENCODE_LAB_DISABLED"

export interface LabPolicy {
  disabled: boolean
  source: "file" | "env" | "none"
  network: SandboxNetworkPolicy
  networkAllow: string[]
  secrets: SandboxSecretsPolicy
  secretsAllow: string[]
}

function policyFile(projectRoot: string): string {
  return path.join(labPaths(projectRoot).home, "policy.json")
}

function envDisabled(): boolean {
  return process.env[LAB_DISABLED_ENV] === "1" || process.env[LAB_DISABLED_ENV] === "true"
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) return []
  return raw as string[]
}

function defaults(): { network: SandboxNetworkPolicy; networkAllow: string[]; secrets: SandboxSecretsPolicy; secretsAllow: string[] } {
  return { network: "none", networkAllow: [], secrets: "none", secretsAllow: [] }
}

// The kill switch wins before any sandbox is planned, and the environment always beats the policy file.
export async function readLabPolicy(projectRoot: string): Promise<LabPolicy> {
  if (envDisabled()) {
    const fallback = defaults()
    return { disabled: true, source: "env", ...fallback }
  }
  const fallback = defaults()
  try {
    const parsed = JSON.parse(await fs.readFile(policyFile(projectRoot), "utf-8")) as {
      disabled?: unknown
      network?: unknown
      networkAllow?: unknown
      secrets?: unknown
      secretsAllow?: unknown
    }
    const disabled = parsed.disabled === true ? true : parsed.disabled === false ? false : false
    const source: "file" | "none" = parsed.disabled === true || parsed.disabled === false ? "file" : "none"
    const network = isSandboxNetworkPolicy(parsed.network) ? parsed.network : fallback.network
    const networkAllow = parsed.networkAllow === undefined ? fallback.networkAllow : stringList(parsed.networkAllow)
    const secrets = isSandboxSecretsPolicy(parsed.secrets) ? parsed.secrets : fallback.secrets
    const secretsAllow = parsed.secretsAllow === undefined ? fallback.secretsAllow : stringList(parsed.secretsAllow)
    return { disabled, source, network, networkAllow, secrets, secretsAllow }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { disabled: false, source: "none", ...fallback }
    }
    if (error instanceof SyntaxError) {
      return { disabled: false, source: "none", ...fallback }
    }
    throw error
  }
}

// Create and run degrade to safe no-ops while the kill switch holds, so callers ask only this one gate.
export async function isLabDisabled(projectRoot: string): Promise<boolean> {
  return (await readLabPolicy(projectRoot)).disabled
}

// Flips the policy file on disk, so the decision survives processes and stays under project control.
export async function setLabDisabled(projectRoot: string, disabled: boolean): Promise<string> {
  const home = labPaths(projectRoot).home
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  const file = policyFile(projectRoot)
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch {
    existing = {}
  }
  const next = { ...existing, disabled }
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
  await fs.chmod(file, 0o600)
  await appendLabAudit({
    kind: "lab_policy",
    projectRoot,
    when: new Date().toISOString(),
    isolationProvider: "n/a",
    details: { disabled, source: "file" },
  })
  return file
}

export function labPolicyFile(projectRoot: string): string {
  return policyFile(projectRoot)
}
