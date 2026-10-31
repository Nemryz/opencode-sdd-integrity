import fs from "node:fs/promises"
import path from "node:path"
import type { LabAdapter, LabPlanContext, LabSelection, LabStep } from "../core/types"

const VITEST_CONFIG = "tools/lab/vitest.config.lab.ts"
const VITEST_BIN = "node_modules/vitest/vitest.mjs"
const NPM = process.platform === "win32" ? "npm.cmd" : "npm"

const EXCLUDES = [
  "**/*-mutation.test.ts",
  "**/*-mutation-*.test.ts",
  "**/*-kill-survivors.test.ts",
  "**/*-kill.test.ts",
]

const CATEGORIES: LabAdapter["categories"] = {
  all: { description: "The whole non-mutation suite", paths: [] },
  unit: { description: "Pure functions", paths: ["tools/test/unit"] },
  integration: { description: "Tools against a real filesystem", paths: ["tools/test/integration"] },
  property: { description: "Generated inputs and invariants", paths: ["tools/test/property"] },
  chaos: { description: "Injected filesystem failures", paths: ["tools/test/chaos"] },
  concurrency: { description: "Locking under parallel access", paths: ["tools/test/concurrency"] },
  fuzz: { description: "Hostile schema values", paths: ["tools/test/fuzz"] },
  snapshot: { description: "Exact command output", paths: ["tools/test/snapshot"] },
  install: { description: "Installer surface and CLI", paths: ["tools/test/install"] },
  manual: { description: "Workflow scripts and manual cases", paths: ["tools/test/manual"] },
  smoke: { description: "The real OpenCode 2 CLI smoke probe", paths: [] },
}

function vitestStep(
  label: string,
  paths: string[],
  context: LabPlanContext,
  options: { coverage?: boolean; shuffle?: boolean; seed?: string; requiresConfirmation?: boolean; flake?: boolean } = {},
): LabStep {
  const reportFile = path.join(context.reportDir, `${label.replace(/[^a-z0-9]+/gi, "-")}.json`)
  const args = [
    VITEST_BIN,
    "run",
    "--config",
    VITEST_CONFIG,
    "--reporter=json",
    "--outputFile",
    reportFile,
  ]
  for (const pattern of EXCLUDES) args.push("--exclude", pattern)
  if (options.shuffle) {
    args.push("--sequence.shuffle")
    if (options.seed) args.push("--sequence.seed", options.seed)
  }
  let coverageFile: string | undefined
  if (options.coverage) {
    const coverageDir = path.join(context.reportDir, "coverage")
    args.push(
      "--coverage.enabled",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=text-summary",
      "--coverage.reportsDirectory",
      coverageDir,
    )
    coverageFile = path.join(coverageDir, "coverage-summary.json")
  }
  args.push(...paths)
  const step: LabStep = {
    label,
    command: "node",
    args,
    reportFile,
    coverageFile,
    timeoutMs: 30 * 60 * 1000,
    requiresConfirmation: options.requiresConfirmation,
    seed: options.seed,
    continueOnFailure: options.flake,
  }
  if (options.flake) {
    step.rerun = ({ files, seed: rerunSeed, attempt, kind }) => {
      const rerunReport = path.join(context.reportDir, `${label.replace(/[^a-z0-9]+/gi, "-")}-flake-${kind}-${attempt}.json`)
      const rerunArgs = [
        VITEST_BIN,
        "run",
        "--config",
        VITEST_CONFIG,
        "--reporter=json",
        "--outputFile",
        rerunReport,
      ]
      for (const pattern of EXCLUDES) rerunArgs.push("--exclude", pattern)
      if (rerunSeed) {
        rerunArgs.push("--sequence.shuffle", "--sequence.seed", rerunSeed)
      }
      rerunArgs.push(...files)
      return {
        label: `${label}-flake-${kind}-${attempt}`,
        command: "node",
        args: rerunArgs,
        reportFile: rerunReport,
        timeoutMs: 10 * 60 * 1000,
        seed: rerunSeed,
      }
    }
  }
  return step
}

function npmStep(label: string, script: string, timeoutMs: number): LabStep {
  return {
    label,
    command: NPM,
    args: ["run", script],
    timeoutMs,
  }
}

export const integrityAdapter: LabAdapter = {
  id: "integrity",
  description: "The opencode-sdd-integrity suite, split by test type and with mutation suites removed",
  categories: CATEGORIES,
  profiles: {
    quick: { description: "Unit tests only, for the tightest loop" },
    standard: { description: "Every non-mutation test plus typecheck and language lint" },
    hard: { description: "Coverage, shuffled order and the static gates" },
    soak: { description: "Three shuffled full runs plus the static gates; heavy and confirmation gated" },
  },
  defaultExclude: EXCLUDES,
  plan(selection: LabSelection, context: LabPlanContext): LabStep[] {
    if (selection.category === "smoke") {
      if (process.platform === "win32") {
        throw new Error("The smoke category runs a POSIX shell script and is not available on Windows")
      }
      return [
        {
          label: "smoke",
          command: "bash",
          args: ["tools/test/smoke/v2-smoke.sh"],
          timeoutMs: 30 * 60 * 1000,
          requiresConfirmation: true,
        },
      ]
    }

    if (selection.category) {
      const category = CATEGORIES[selection.category]
      return [vitestStep(selection.category, category.paths, context)]
    }

    if (selection.profile === "quick") {
      return [vitestStep("unit", CATEGORIES.unit.paths, context)]
    }
    if (selection.profile === "standard") {
      return [
        vitestStep("all", [], context),
        npmStep("typecheck", "typecheck", 5 * 60 * 1000),
        npmStep("lint", "lint:lang", 5 * 60 * 1000),
      ]
    }
    if (selection.profile === "hard") {
      return [
        vitestStep("all", [], context, { coverage: true, shuffle: true, seed: "20261022" }),
        npmStep("typecheck", "typecheck", 5 * 60 * 1000),
        npmStep("lint", "lint:lang", 5 * 60 * 1000),
      ]
    }
    if (selection.profile === "soak") {
      return [
        vitestStep("soak-1", [], context, { shuffle: true, seed: "20261022", requiresConfirmation: true, flake: true }),
        vitestStep("soak-2", [], context, { shuffle: true, seed: "20261023", flake: true }),
        vitestStep("soak-3", [], context, { coverage: true, shuffle: true, seed: "20261024", flake: true }),
        npmStep("typecheck", "typecheck", 5 * 60 * 1000),
        npmStep("lint", "lint:lang", 5 * 60 * 1000),
      ]
    }
    throw new Error(`The integrity adapter does not know ${selection.profile ?? "that selection"}`)
  },
}

export async function isIntegrityRepo(repoRoot: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8")) as { name?: string }
    if (pkg.name === "opencode-sdd-integrity") return true
  } catch {
    return false
  }
  try {
    await fs.access(path.join(repoRoot, "mutation-batches.json"))
    await fs.access(path.join(repoRoot, "vitest.config.ts"))
    return true
  } catch {
    return false
  }
}
