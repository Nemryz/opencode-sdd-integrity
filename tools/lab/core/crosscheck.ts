import { isLabSandboxRoot } from "./home"
import { safeSegment } from "./paths"
import { labPaths } from "./home"
import type { LabSandbox } from "./types"

export interface PromotionCheck {
  ok: boolean
  findings: string[]
}

function checkFindings(sandbox: LabSandbox, projectRoot: string, options: { reviewedPatchHash?: string } = {}): string[] {
  const findings: string[] = []
  if (typeof sandbox.id !== "string" || safeSegmentThrows(sandbox.id)) {
    findings.push(`sandbox id ${String(sandbox.id)} is not a safe segment`)
  }
  if (typeof sandbox.sandboxRoot !== "string" || !isLabSandboxRoot(projectRoot, sandbox.sandboxRoot)) {
    findings.push(`sandbox root escapes ${labPaths(projectRoot).sandboxes}`)
  }
  if (sandbox.status === "destroyed") {
    findings.push(`sandbox ${sandbox.id} was destroyed, so no patch may be applied`)
  }
  if (options.reviewedPatchHash !== undefined && sandbox.lastDiffHash !== undefined && sandbox.lastDiffHash !== options.reviewedPatchHash) {
    findings.push(`the reviewed patch hash ${sandbox.lastDiffHash.slice(0, 12)} does not belong to patch ${options.reviewedPatchHash.slice(0, 12)}`)
  }
  return findings
}

function safeSegmentThrows(value: string): boolean {
  try {
    safeSegment(value)
    return false
  } catch {
    return true
  }
}

// Cross-checks the registry against itself before promotion follows its instructions, so a tampered entry wins nothing.
export function validatePromotion(
  projectRoot: string,
  sandbox: LabSandbox,
  options: { reviewedPatchHash?: string } = {},
): PromotionCheck {
  const findings = checkFindings(sandbox, projectRoot, options)
  return { ok: findings.length === 0, findings }
}

export function formatPromotionCheck(check: PromotionCheck): string {
  if (check.ok) return "The sandbox passed the registry cross check."
  const lines = ["The sandbox failed the registry cross check", ""]
  for (const finding of check.findings) lines.push(`  - ${finding}`)
  return lines.join("\n")
}
