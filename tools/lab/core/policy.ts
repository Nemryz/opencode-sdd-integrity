import fs from "node:fs/promises"
import path from "node:path"
import { labPaths } from "./home"
import { appendLabAudit } from "./audit"

export const LAB_DISABLED_ENV = "OPENCODE_LAB_DISABLED"

export interface LabPolicy {
  disabled: boolean
  source: "file" | "env" | "none"
}

function policyFile(projectRoot: string): string {
  return path.join(labPaths(projectRoot).home, "policy.json")
}

function envDisabled(): boolean {
  return process.env[LAB_DISABLED_ENV] === "1" || process.env[LAB_DISABLED_ENV] === "true"
}

// The kill switch wins before any sandbox is planned, and the environment always beats the policy file.
export async function readLabPolicy(projectRoot: string): Promise<LabPolicy> {
  if (envDisabled()) return { disabled: true, source: "env" }
  try {
    const parsed = JSON.parse(await fs.readFile(policyFile(projectRoot), "utf-8")) as { disabled?: unknown }
    if (parsed.disabled === true) return { disabled: true, source: "file" }
    if (parsed.disabled === false) return { disabled: false, source: "file" }
    return { disabled: false, source: "none" }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { disabled: false, source: "none" }
    }
    if (error instanceof SyntaxError) {
      return { disabled: false, source: "none" }
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
  await fs.writeFile(file, `${JSON.stringify({ disabled }, null, 2)}\n`, "utf-8")
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
