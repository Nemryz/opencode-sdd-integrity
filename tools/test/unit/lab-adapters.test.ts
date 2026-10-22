import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { createNodeAdapter, integrityAdapter, selectAdapter } from "../../lab/adapters"
import type { LabPlanContext } from "../../lab/core/types"

let worktree: string

function context(): LabPlanContext {
  return { sandboxRoot: worktree, reportDir: path.join(worktree, "reports", "lab", "run") }
}

async function writePackage(root: string, pkg: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2), "utf-8")
}

beforeEach(async () => {
  worktree = await createTempWorktree()
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("integrity lab adapter", () => {
  it("plans the quick profile with mutation suites excluded", () => {
    const steps = integrityAdapter.plan({ profile: "quick" }, context())
    expect(steps).toHaveLength(1)
    expect(steps[0]?.args).toContain("tools/test/unit")
    expect(steps[0]?.args).toContain("--exclude")
    expect(steps[0]?.args).toContain("**/*-mutation.test.ts")
    expect(steps[0]?.args).toContain("**/*-kill-survivors.test.ts")
    expect(integrityAdapter.defaultExclude).toContain("**/*-mutation-*.test.ts")
  })

  it("plans coverage for the hard profile and a confirmation gate for soak", () => {
    const hard = integrityAdapter.plan({ profile: "hard" }, context())
    expect(hard[0]?.args).toContain("--coverage.enabled")
    expect(hard[0]?.coverageFile).toContain("coverage-summary.json")
    expect(hard.map((step) => step.label)).toEqual(["all", "typecheck", "lint"])

    const soak = integrityAdapter.plan({ profile: "soak" }, context())
    expect(soak).toHaveLength(5)
    expect(soak[0]?.requiresConfirmation).toBe(true)
    expect(soak.filter((step) => step.reportFile)).toHaveLength(3)
  })

  it("keeps the all category free of path filters and reports the output file", () => {
    const [step] = integrityAdapter.plan({ category: "all" }, context())
    expect(step?.label).toBe("all")
    expect(step?.reportFile).toContain("all.json")
    expect(step?.args).not.toContain("tools/test/unit")
    expect(step?.args.filter((arg) => arg === "--exclude")).toHaveLength(4)
  })

  it("gates the smoke category behind confirmation and rejects it on Windows", () => {
    if (process.platform === "win32") {
      expect(() => integrityAdapter.plan({ category: "smoke" }, context())).toThrow(/POSIX/)
      return
    }
    const [step] = integrityAdapter.plan({ category: "smoke" }, context())
    expect(step?.requiresConfirmation).toBe(true)
    expect(step?.command).toBe("bash")
  })
})

describe("node lab adapter", () => {
  it("detects available scripts and plans the standard profile", async () => {
    await writePackage(worktree, {
      name: "sample",
      scripts: {
        test: "vitest run",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        "test:coverage": "vitest run --coverage",
      },
    })
    const adapter = await createNodeAdapter(worktree)
    expect(Object.keys(adapter.categories).sort()).toEqual(["coverage", "lint", "test", "typecheck"])
    const steps = adapter.plan({ profile: "standard" }, context())
    expect(steps.map((step) => step.label)).toEqual(["test", "typecheck", "lint"])
    expect(steps[0]?.args).toEqual(["run", "test"])
  })

  it("uses the available coverage script for the hard profile", async () => {
    await writePackage(worktree, {
      name: "sample",
      scripts: { test: "vitest run", "test:coverage": "vitest run --coverage" },
    })
    const adapter = await createNodeAdapter(worktree)
    const [step] = adapter.plan({ profile: "hard" }, context())
    expect(step?.label).toBe("coverage")
    expect(step?.coverageFile).toContain(path.join("coverage", "coverage-summary.json"))
  })

  it("selects integrity by package name and node by package.json fallback", async () => {
    await writePackage(worktree, { name: "opencode-sdd-integrity" })
    expect((await selectAdapter(worktree)).id).toBe("integrity")

    await writePackage(worktree, { name: "sample", scripts: { test: "true" } })
    expect((await selectAdapter(worktree)).id).toBe("node")
  })

  it("fails with a clear message when the test script is missing", async () => {
    await writePackage(worktree, { name: "sample", scripts: { lint: "eslint ." } })
    const adapter = await createNodeAdapter(worktree)
    expect(() => adapter.plan({ profile: "quick" }, context())).toThrow(/no test script/)
  })
})

describe("lab adapter selection", () => {
  it("returns no adapter for a project without package metadata", async () => {
    await expect(selectAdapter(worktree)).rejects.toThrow(/No lab adapter/)
  })

  it("honors an explicit integrity request", async () => {
    const adapter = await selectAdapter(worktree, "integrity")
    expect(adapter.id).toBe("integrity")
  })

  it("honors an explicit node request and fails without package.json", async () => {
    await expect(selectAdapter(worktree, "node")).rejects.toThrow(/package.json/)
  })
})
