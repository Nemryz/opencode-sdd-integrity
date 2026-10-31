import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import { getProjectRootWarnings, resolveProjectRoot } from "./shared/types"
import { selectAdapter, type AdapterChoice } from "./lab/adapters"
import { collectDiff, formatDiff, promoteDiff, reviewDiff } from "./lab/core/diff"
import { findGitRoot, statusShort } from "./lab/core/git"
import { writeJsonAtomic, writeTextAtomic } from "./lab/core/fs"
import { listSandboxes, latestRunSummary, readRunSummary } from "./lab/core/registry"
import { formatRunSummary } from "./lab/core/report"
import { createBaseline, compareRunToBaseline, formatComparison, readBaseline, writeBaseline, comparisonMarkdown, comparisonMarkdownPath, comparisonPath } from "./lab/core/baseline"
import { runLab } from "./lab/core/run"
import { createSandbox, destroySandbox, formatSandbox, loadSandbox } from "./lab/core/sandbox"
import { pruneSandboxes } from "./lab/core/prune"
import type { LabSandbox } from "./lab/core/types"

const SUBCOMMANDS = ["create", "run", "status", "diff", "promote", "destroy", "list", "prune", "baseline", "compare", "help"] as const

function listOutput(sandboxes: LabSandbox[]): string {
  if (sandboxes.length === 0) {
    return "No lab sandboxes. Create one with subcommand create."
  }
  const lines = ["Lab sandboxes", ""]
  for (const sandbox of sandboxes.slice(0, 20)) {
    const label = sandbox.label ? ` ${sandbox.label}` : ""
    const last = sandbox.lastRunAt ? ` last=${sandbox.lastRunStatus ?? "unknown"}@${sandbox.lastRunAt}` : ""
    lines.push(
      `${sandbox.id}  ${sandbox.status.padEnd(9)} ${sandbox.adapter.padEnd(9)} ${sandbox.createdAt}${last}${label}`,
    )
  }
  if (sandboxes.length > 20) lines.push(`... and ${sandboxes.length - 20} older sandboxes`)
  lines.push("", "Use status, diff, promote or destroy with an id.")
  return lines.join("\n")
}

function helpOutput(): string {
  return [
    "speckit-lab: isolated, non-mutation test runs",
    "",
    "Subcommands:",
    "  create [label]          Create a git worktree sandbox and prepare dependencies",
    "  run <category|profile>  Run tests inside the newest sandbox",
    "  status [id]             Show the sandbox, dirty files and the latest run",
    "  diff [id]               Write a patch and show its stat; does not modify the checkout",
    "  promote [id]            Apply the patch after confirmation and only if HEAD is unchanged",
    "  destroy [id]            Remove the worktree after explicit confirmation; reports stay",
    "  prune [days]            Dry-run or remove stale sandboxes, reports and orphan worktrees",
    "  baseline [selection]    Store the latest successful run as the baseline",
    "  compare [selection]     Compare the latest run against the stored baseline",
    "  list                    List known sandboxes",
    "",
    "Integrity categories: all, unit, integration, property, chaos, concurrency, fuzz, snapshot, install, manual, smoke",
    "Profiles: quick, standard, hard, soak",
    "Generic adapter categories and profiles come from package.json scripts.",
    "",
    "The lab never runs mutation tests; reports live under reports/lab and stay out of git.",
  ].join("\n")
}

export default tool({
  description: "Create an isolated git worktree, run non-mutation test profiles there, and promote reviewed changes",
  args: {
    subcommand: tool.schema.enum(SUBCOMMANDS).optional().describe("Lab subcommand (default: list)"),
    id: tool.schema.string().optional().describe("Sandbox id; omit to use the newest active sandbox"),
    category: tool.schema.string().optional().describe("Test category for the run subcommand"),
    profile: tool.schema.string().optional().describe("Run profile: quick, standard, hard or soak"),
    adapter: tool.schema.enum(["auto", "integrity", "node"]).optional().describe("Adapter selection for create"),
    label: tool.schema.string().optional().describe("Optional label for a new sandbox"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms"),
    allowMoved: tool.schema.boolean().optional().describe("Allow promotion when the checkout HEAD moved since create; applies the patch with three-way merge"),
    olderThanDays: tool.schema.number().optional().describe("Retention age in days for prune; defaults to 30"),
    runId: tool.schema.string().optional().describe("Run id; omit to use the latest run in the sandbox"),
  },
  async execute(args, context) {
    try {
      const resolved = await resolveProjectRoot(context)
      if (!resolved.root) return { title: "Error", output: resolved.error ?? "Not a valid project directory" }
      const projectRoot = resolved.root
      const subcommand = args.subcommand ?? "list"

      if (subcommand === "help") {
        return { title: "Test Lab", output: helpOutput() }
      }

      if (subcommand === "list") {
        const sandboxes = await listSandboxes(projectRoot)
        return { title: "Test Lab Sandboxes", output: listOutput(sandboxes), metadata: { count: sandboxes.length } }
      }

      if (subcommand === "prune") {
        const result = await pruneSandboxes({
          projectRoot,
          olderThanDays: args.olderThanDays,
          confirmed: args.confirmed === true,
        })
        const lines = [
          result.dryRun ? "Lab prune: dry run" : "Lab prune: completed",
          `  retention: ${result.olderThanDays} days`,
          `  candidates: ${result.candidates.length}`,
        ]
        for (const candidate of result.candidates) {
          lines.push(`    ${candidate.id}  ${candidate.reason}  ${candidate.action}${candidate.path ? `  ${candidate.path}` : ""}`)
        }
        if (result.dryRun) {
          lines.push("", "Re-run with confirmed: true to apply the prune.")
        } else {
          lines.push("", `Removed: ${result.removed.length}`, `Marked destroyed: ${result.markedDestroyed.length}`, `Orphan worktrees: ${result.orphanWorktrees.length}`)
        }
        return {
          title: result.dryRun ? "Lab Prune: Dry Run" : "Lab Prune: Completed",
          output: lines.join("\n"),
          metadata: { dryRun: result.dryRun, candidates: result.candidates.length, removed: result.removed.length },
        }
      }

      if (subcommand === "create") {
        const warnings = await getProjectRootWarnings(projectRoot)
        if (warnings.length > 0 && !args.confirmed) {
          return {
            title: "Warning",
            output: `${warnings.map((warning) => warning.message).join("\n\n")}\n\nAsk the user to confirm, then re-run create with confirmed: true.`,
            metadata: { warnings, requiresConfirmation: true },
          }
        }
        const repoRoot = (await findGitRoot(projectRoot)) ?? projectRoot
        const adapter = await selectAdapter(repoRoot, (args.adapter ?? "auto") as AdapterChoice)
        const sandbox = await createSandbox({ projectRoot, adapter: adapter.id, label: args.label })
        return {
          title: "Lab Sandbox Created",
          output: `${formatSandbox(sandbox)}\n\nNext: run a category such as unit, or a profile such as quick.`,
          metadata: { sandboxId: sandbox.id, sandboxRoot: sandbox.sandboxRoot, adapter: sandbox.adapter },
        }
      }

      const sandbox = await loadSandbox(projectRoot, args.id, { allowMissing: subcommand === "destroy" })

      if (subcommand === "status") {
        const dirty = await statusShort(sandbox.sandboxRoot)
        const latest = await latestRunSummary(projectRoot, sandbox.id)
        const lines = [formatSandbox(sandbox)]
        if (dirty) {
          lines.push("", "Dirty files in the sandbox:", ...dirty.split(/\r?\n/).slice(0, 20))
        } else {
          lines.push("", "The sandbox is clean.")
        }
        if (latest) {
          lines.push("", "Latest run:", formatRunSummary(latest))
        } else {
          lines.push("", "No run has been recorded yet.")
        }
        return {
          title: `Lab Sandbox: ${sandbox.status}`,
          output: lines.join("\n"),
          metadata: { sandboxId: sandbox.id, status: sandbox.status, dirty: dirty !== "", latestRunId: latest?.runId },
        }
      }

      if (subcommand === "run") {
        const adapter = await selectAdapter(sandbox.repoRoot, sandbox.adapter as AdapterChoice)
        const selection = args.category
          ? { category: args.category }
          : { profile: args.profile ?? "quick" }
        const preview = adapter.plan(selection, {
          sandboxRoot: sandbox.sandboxRoot,
          reportDir: path.join(projectRoot, "reports", "lab", sandbox.id, "preview"),
        })
        if (preview.some((step) => step.requiresConfirmation) && !args.confirmed) {
          return {
            title: "Confirm Lab Run",
            output:
              "This run is heavy or touches an external system. Ask the user to confirm, then re-run the same command with confirmed: true.",
            metadata: { sandboxId: sandbox.id, category: args.category, profile: args.profile, requiresConfirmation: true },
          }
        }
        const summary = await runLab({
          projectRoot,
          sandbox,
          adapter,
          selection,
          confirmed: args.confirmed,
          signal: context.abort,
        })
        return {
          title: `Lab Run: ${summary.status}`,
          output: `${formatRunSummary(summary)}\n\nReports: ${summary.summaryPath}`,
          metadata: {
            sandboxId: sandbox.id,
            runId: summary.runId,
            status: summary.status,
            summaryPath: summary.summaryPath,
            tests: summary.totals,
            coverage: summary.coverage,
          },
        }
      }

      if (subcommand === "diff") {
        const diff = await reviewDiff(projectRoot, sandbox)
        return {
          title: diff.empty ? "Lab Diff: empty" : "Lab Diff",
          output: formatDiff(diff),
          metadata: {
            sandboxId: sandbox.id,
            files: diff.files,
            patchPath: diff.patchPath,
            empty: diff.empty,
            baseCommit: diff.baseCommit,
            currentHead: diff.currentHead,
          },
        }
      }

      if (subcommand === "promote") {
        if (sandbox.status === "promoted") {
          return {
            title: "Already Promoted",
            output: `Sandbox ${sandbox.id} was already promoted. Create a new sandbox for another change.`,
          }
        }
        const warnings = await getProjectRootWarnings(projectRoot)
        if (!args.confirmed) {
          const warningText = warnings.length > 0 ? `${warnings.map((warning) => warning.message).join("\n\n")}\n\n` : ""
          return {
            title: warnings.length > 0 ? "Warning" : "Confirm Promote",
            output: `${warningText}Promote applies the sandbox patch to ${sandbox.repoRoot} in the working tree, without committing. Run diff first to review it, then re-run promote with confirmed: true after the user confirms.`,
            metadata: { sandboxId: sandbox.id, requiresConfirmation: true, warnings },
          }
        }
        const diff = await promoteDiff(projectRoot, sandbox, { allowMoved: args.allowMoved === true })
        return {
          title: "Lab Patch Promoted",
          output: [
            `Applied ${diff.files.length} file(s) to ${sandbox.repoRoot}.`,
            `  patch: ${diff.patchPath}`,
            "",
            diff.stat,
            "",
            "The checkout is not committed. Review it, run the normal suite, then commit.",
          ].join("\n"),
          metadata: { sandboxId: sandbox.id, files: diff.files, patchPath: diff.patchPath },
        }
      }

      if (subcommand === "destroy") {
        if (!args.confirmed) {
          return {
            title: "Confirm Destroy",
            output: `Destroy removes the sandbox worktree at ${sandbox.sandboxRoot}. Reports and patches under reports/lab stay. Re-run with confirmed: true after the user confirms.`,
            metadata: { sandboxId: sandbox.id, requiresConfirmation: true },
          }
        }
        await destroySandbox(projectRoot, sandbox)
        return {
          title: "Lab Sandbox Destroyed",
          output: `Removed ${sandbox.id}. Reports remain under ${projectRoot}/reports/lab.`,
          metadata: { sandboxId: sandbox.id, destroyed: true },
        }
      }

      if (subcommand === "baseline") {
        const summary = args.runId
          ? await readRunSummary(projectRoot, sandbox.id, args.runId)
          : await latestRunSummary(projectRoot, sandbox.id)
        if (!summary) throw new Error(`No run found for sandbox ${sandbox.id}`)
        const selection = args.category
          ? { category: args.category }
          : args.profile
            ? { profile: args.profile }
            : summary.selection
        if (JSON.stringify(selection) !== JSON.stringify(summary.selection)) {
          throw new Error("The baseline selection must match the run selection")
        }
        if (summary.status !== "passed") throw new Error("Only a passed run can become a baseline")
        const baseline = createBaseline(summary, sandbox.baseCommit)
        const file = await writeBaseline(projectRoot, baseline)
        return {
          title: "Lab Baseline Stored",
          output: `Stored baseline for ${summary.adapter} ${selection.profile ? `profile ${selection.profile}` : `category ${selection.category ?? "all"}`}.\n  file: ${file}\n  run: ${summary.runId}\n  commit: ${sandbox.baseCommit.slice(0, 12)}`,
          metadata: { sandboxId: sandbox.id, runId: summary.runId, baselinePath: file },
        }
      }

      if (subcommand === "compare") {
        const summary = args.runId
          ? await readRunSummary(projectRoot, sandbox.id, args.runId)
          : await latestRunSummary(projectRoot, sandbox.id)
        if (!summary) throw new Error(`No run found for sandbox ${sandbox.id}`)
        const selection = args.category
          ? { category: args.category }
          : args.profile
            ? { profile: args.profile }
            : summary.selection
        if (JSON.stringify(selection) !== JSON.stringify(summary.selection)) {
          throw new Error("The comparison selection must match the run selection")
        }
        const baseline = await readBaseline(projectRoot, summary.adapter, selection)
        if (!baseline) {
          return {
            title: "Lab Compare: No Baseline",
            output: `No baseline exists for ${summary.adapter} ${selection.profile ? `profile ${selection.profile}` : `category ${selection.category ?? "all"}`}. Store one with subcommand baseline first.`,
            metadata: { sandboxId: sandbox.id, runId: summary.runId, hasBaseline: false },
          }
        }
        const comparison = compareRunToBaseline(summary, baseline)
        const jsonPath = comparisonPath(projectRoot, sandbox.id, summary.runId)
        const markdownPath = comparisonMarkdownPath(projectRoot, sandbox.id, summary.runId)
        await writeJsonAtomic(jsonPath, comparison)
        await writeTextAtomic(markdownPath, comparisonMarkdown(comparison))
        return {
          title: comparison.status === "pass" ? "Lab Compare: Pass" : "Lab Compare: Regressed",
          output: `${formatComparison(comparison)}\n\nReports: ${jsonPath}\n${markdownPath}`,
          metadata: {
            sandboxId: sandbox.id,
            runId: summary.runId,
            regressed: comparison.status === "regressed",
            jsonPath,
            markdownPath,
          },
        }
      }

      return { title: "Error", output: `Unknown subcommand: ${subcommand}` }
    } catch (error) {
      return {
        title: "Lab Error",
        output: error instanceof Error ? error.message : String(error),
        metadata: { error: error instanceof Error ? error.message : String(error) },
      }
    }
  },
})
