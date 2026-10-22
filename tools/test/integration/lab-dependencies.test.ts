import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { ensureDependencies } from "../../lab/core/dependencies"
import { upsertSandbox } from "../../lab/core/registry"
import type { LabSandbox } from "../../lab/core/types"

let project: string | null = null

afterEach(async () => {
  if (project) {
    await destroyTempWorktree(project)
    project = null
  }
})

describe("lab dependency preparation", () => {
  it("installs from the sandbox lockfile and records the install", async () => {
    project = await createTempWorktree()
    const sandboxRoot = path.join(project, "sandbox")
    await fs.mkdir(sandboxRoot, { recursive: true })
    await fs.writeFile(
      path.join(sandboxRoot, "package.json"),
      JSON.stringify({ name: "lab-dependency-fixture", version: "1.0.0", private: true }, null, 2),
      "utf-8",
    )
    await fs.writeFile(
      path.join(sandboxRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "lab-dependency-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "lab-dependency-fixture", version: "1.0.0" } },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const sandbox: LabSandbox = {
      id: "dependency-sandbox",
      projectRoot: project,
      repoRoot: project,
      sandboxRoot,
      adapter: "node",
      baseCommit: "0".repeat(40),
      createdAt: new Date().toISOString(),
      status: "active",
      warnings: [],
    }
    await upsertSandbox(project, sandbox)
    const reportDir = path.join(project, "reports", "lab", sandbox.id, "runs", "run-1")

    const result = await ensureDependencies({ projectRoot: project, sandbox, reportDir })
    expect(result.sandbox.dependencies).toMatchObject({
      strategy: "installed",
      lockfile: "package-lock.json",
      manager: "npm",
    })
    expect(result.note).toContain("Dependencies installed")
    await expect(fs.lstat(path.join(sandboxRoot, "node_modules"))).resolves.toBeDefined()
    await expect(fs.lstat(path.join(reportDir, "dependencies.log"))).resolves.toBeDefined()

    const second = await ensureDependencies({ projectRoot: project, sandbox: result.sandbox, reportDir })
    expect(second.note).toBeUndefined()
  })
})
