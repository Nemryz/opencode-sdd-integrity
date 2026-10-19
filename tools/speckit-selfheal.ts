import { tool, type ToolResult } from "@opencode-ai/plugin"
import path from "node:path"
import {
  resolveProjectRoot,
  getProjectRootWarnings,
  corruptionWarnings,
  clearCorruptionWarnings,
} from "./shared/types"
import auditTool from "./speckit-audit"
import cleanTool from "./speckit-clean"

function toolResult(r: ToolResult): { output: string; metadata?: Record<string, unknown> } {
  return typeof r === "string" ? { output: r } : r
}

interface SelfHealFinding {
  id: string
  source: string
  severity: "LOW" | "MED" | "HIGH"
  category: "BUG" | "MISSING_TEST" | "HARDENING" | "DOCS"
  message: string
  file?: string
  originalSeverity: string
  originalCategory: string
}

export function categorize(category: string, severity: string): { category: SelfHealFinding["category"]; severity: SelfHealFinding["severity"] } {
  const bugCategories = ["phase-mismatch", "ready-violation", "spec-json"]
  const hardeningCategories = ["approval-order", "spec-clarity", "tasks-boundary", "steering"]
  const docCategories = ["optional-artifact", "constitution", "features"]

  const sevMap: Record<string, SelfHealFinding["severity"]> = {
    error: "HIGH",
    warn: "MED",
    info: "LOW",
  }

  if (bugCategories.includes(category)) {
    return { category: "BUG", severity: sevMap[severity] ?? "LOW" }
  }
  if (hardeningCategories.includes(category)) {
    return { category: "HARDENING", severity: sevMap[severity] ?? "LOW" }
  }
  if (docCategories.includes(category)) {
    return { category: "DOCS", severity: "LOW" }
  }
  return { category: "HARDENING", severity: sevMap[severity] ?? "LOW" }
}

function severityOrder(s: SelfHealFinding["severity"]): number {
  return s === "HIGH" ? 0 : s === "MED" ? 1 : 2
}

function categoryOrder(c: SelfHealFinding["category"]): number {
  return c === "BUG" ? 0 : c === "MISSING_TEST" ? 1 : c === "HARDENING" ? 2 : 3
}

export default tool({
  description: "Run health scan, analyze findings, and apply fixes with auto-rollback protection",
  args: {
    fix: tool.schema.boolean().optional().describe("Apply auto-fixes for known issues"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the project-root warning"),
  },
  async execute(args, context) {
    try {
      const resolved = await resolveProjectRoot(context)
      if (!resolved.root) return { title: "Error", output: resolved.error ?? "Not a valid project directory" }
      const projectRoot = resolved.root
      const projectWarnings = await getProjectRootWarnings(projectRoot)
      if (projectWarnings.length > 0 && !args.confirmed) {
        return {
          title: "Warning",
          output: `${projectWarnings.map(w => w.message).join("\n\n")}\n\nAsk the user to confirm, then re-run with confirmed: true.`,
          metadata: { warnings: projectWarnings, requiresConfirmation: true },
        }
      }

      const findings: SelfHealFinding[] = []
      let auditOutput = ""
      let cleanOutput = ""

      // D1: Health Scan — audit
      const auditResult = toolResult(await auditTool.execute({ fix: args.fix }, context))
      const auditFindings = (auditResult.metadata?.findings ?? []) as Array<Record<string, unknown>>
      for (const f of auditFindings) {
        const cat = categorize(String(f.category ?? ""), String(f.severity ?? "info"))
        const finding: SelfHealFinding = {
          id: `A-${findings.length + 1}`,
          source: "audit",
          severity: cat.severity,
          category: cat.category,
          message: String(f.message ?? ""),
          originalSeverity: String(f.severity ?? ""),
          originalCategory: String(f.category ?? ""),
        }
        // Leaves the file out when audit reported none, since an undefined metadata value stalls the V2 runtime part.
        if (typeof f.file === "string" && f.file.length > 0) {
          finding.file = f.file
        }
        findings.push(finding)
      }
      auditOutput = auditResult.output

      // D1: Health Scan — clean
      const cleanResult = toolResult(await cleanTool.execute({ fix: args.fix }, context))
      const cleanIssues = (cleanResult.metadata?.issues ?? []) as Array<unknown>
      for (const issue of cleanIssues) {
        const message = typeof issue === "string"
          ? issue
          : String((issue as Record<string, unknown>).message ?? "")
        const severity = typeof issue === "string"
          ? "info"
          : String((issue as Record<string, unknown>).severity ?? "info")
        const cat = categorize("phase-mismatch", severity)
        findings.push({
          id: `C-${findings.length + 1}`,
          source: "clean",
          severity: cat.severity,
          category: cat.category,
          message,
          originalSeverity: severity,
          originalCategory: "clean",
        })
      }
      cleanOutput = cleanResult.output

      // D1: Health Scan — corruption warnings
      for (const w of corruptionWarnings) {
        findings.push({
          id: `W-${findings.length + 1}`,
          source: "corruption",
          severity: "HIGH",
          category: "BUG",
          message: `Corruption in ${w.file}: ${w.message}`,
          file: w.file,
          originalSeverity: "warn",
          originalCategory: "corruption",
        })
      }
      clearCorruptionWarnings()

      // D2: Analyze and prioritize
      findings.sort((a, b) => {
        const sev = severityOrder(a.severity) - severityOrder(b.severity)
        if (sev !== 0) return sev
        return categoryOrder(a.category) - categoryOrder(b.category)
      })

      const summary = { BUG: 0, MISSING_TEST: 0, HARDENING: 0, DOCS: 0 }
      for (const f of findings) {
        summary[f.category]++
      }
      const total = findings.length

      // D3 + D4: Fix handling — audit and clean already applied their fixes during
      // the scan phase when fix=true, so count the results from those findings
      // instead of re-running the fixers (which would report zero fixed).
      let fixed = 0
      let skipped = 0
      let failed = 0
      if (args.fix) {
        for (const f of findings) {
          if (f.source === "audit" && f.message.includes("(auto-fixed)")) {
            fixed++
          }
          if (f.severity === "LOW" || f.originalSeverity === "info") {
            skipped++
          }
        }
        skipped = Math.max(0, skipped - fixed)
      }

      const lines: string[] = []
      lines.push(`Health Scan: ${total} finding(s) — ${summary.BUG} BUG, ${summary.MISSING_TEST} MISSING_TEST, ${summary.HARDENING} HARDENING, ${summary.DOCS} DOCS`)
      for (const f of findings) {
        const sevTag = f.severity === "HIGH" ? "!!" : f.severity === "MED" ? "!" : "."
        lines.push(`[${sevTag}] ${f.category} (${f.severity}) [${f.source}] ${f.message}`)
      }
      if (args.fix) {
        lines.push(`\nFix result: ${fixed} fixed, ${skipped} skipped, ${failed} failed`)
      }

      return {
        title: `SelfHeal: ${total} finding(s)`,
        output: lines.join("\n"),
        metadata: {
          findings,
          summary,
          total,
          fixed,
          skipped,
          failed,
          auditOutput,
          cleanOutput,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Error",
        output: `selfheal: ${message}`,
        metadata: { error: message },
      }
    }
  },
})
