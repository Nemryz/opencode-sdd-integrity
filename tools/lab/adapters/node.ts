import fs from "node:fs/promises"
import path from "node:path"
import type { LabAdapter, LabPlanContext, LabSelection, LabStep } from "../core/types"

type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

interface PackageJson {
  scripts?: Record<string, string>
}

function managerCommand(manager: PackageManager): string {
  if (process.platform !== "win32") return manager
  return manager === "bun" ? "bun" : `${manager}.cmd`
}

async function detectManager(repoRoot: string): Promise<PackageManager> {
  for (const [file, manager] of [
    ["npm-shrinkwrap.json", "npm"],
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ] as const) {
    try {
      await fs.access(path.join(repoRoot, file))
      return manager
    } catch {
      // try the next lockfile
    }
  }
  return "npm"
}

export async function createNodeAdapter(repoRoot: string): Promise<LabAdapter> {
  let pkg: PackageJson
  try {
    pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8")) as PackageJson
  } catch {
    throw new Error("The node adapter needs a package.json")
  }
  const scripts = pkg.scripts ?? {}
  const manager = await detectManager(repoRoot)
  const command = managerCommand(manager)

  const scriptStep = (label: string, script: string, timeoutMs: number): LabStep => ({
    label,
    command,
    args: ["run", script],
    timeoutMs,
  })

  const available = (name: string): boolean => typeof scripts[name] === "string" && scripts[name].trim() !== ""
  const lintScript = available("lint") ? "lint" : available("lint:lang") ? "lint:lang" : null

  const categories: LabAdapter["categories"] = {}
  if (available("test")) categories.test = { description: "The project test script", paths: [] }
  if (available("typecheck")) categories.typecheck = { description: "The project typecheck script", paths: [] }
  if (lintScript) categories.lint = { description: "The project lint script", paths: [] }
  if (available("test:coverage")) categories.coverage = { description: "The project coverage script", paths: [] }

  const coverageStep = (context: LabPlanContext): LabStep | null => {
    if (!available("test:coverage")) return null
    return {
      ...scriptStep("coverage", "test:coverage", 20 * 60 * 1000),
      coverageFile: path.join(context.sandboxRoot, "coverage", "coverage-summary.json"),
    }
  }

  const testStep = (): LabStep => {
    if (!available("test")) throw new Error("package.json has no test script")
    return scriptStep("test", "test", 20 * 60 * 1000)
  }

  const staticSteps = (): LabStep[] => {
    const steps: LabStep[] = []
    if (available("typecheck")) steps.push(scriptStep("typecheck", "typecheck", 5 * 60 * 1000))
    if (lintScript) steps.push(scriptStep("lint", lintScript, 5 * 60 * 1000))
    return steps
  }

  const plan = (selection: LabSelection, context: LabPlanContext): LabStep[] => {
    if (selection.category === "test") return [testStep()]
    if (selection.category === "typecheck") {
      if (!available("typecheck")) throw new Error("package.json has no typecheck script")
      return [scriptStep("typecheck", "typecheck", 5 * 60 * 1000)]
    }
    if (selection.category === "lint") {
      if (!lintScript) throw new Error("package.json has no lint script")
      return [scriptStep("lint", lintScript, 5 * 60 * 1000)]
    }
    if (selection.category === "coverage") {
      const step = coverageStep(context)
      if (!step) throw new Error("package.json has no test:coverage script")
      return [step]
    }

    if (selection.profile === "quick") return [testStep()]
    if (selection.profile === "standard") return [testStep(), ...staticSteps()]
    if (selection.profile === "hard") {
      const coverage = coverageStep(context)
      return [coverage ?? testStep(), ...staticSteps()]
    }
    throw new Error(`The node adapter does not know ${selection.profile ?? "that selection"}`)
  }

  return {
    id: "node",
    description: "A generic package.json adapter that runs the project scripts",
    categories,
    profiles: {
      quick: { description: "The test script only" },
      standard: { description: "Tests plus typecheck and lint when the scripts exist" },
      hard: { description: "Coverage when available, plus typecheck and lint" },
    },
    defaultExclude: [],
    plan,
  }
}

export async function isNodeRepo(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, "package.json"))
    return true
  } catch {
    return false
  }
}
