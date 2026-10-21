import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

let worktree: string

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-boundary-"))
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("boundary-first task annotations integration", () => {
  const ctx = mockContext(worktree)

  it("validates boundary names on parallel [P] tasks are unique", async () => {
    const tasksMd = `# Tasks for 001-demo

- [ ] T-001 Scaffold spec dir [P] _Boundary: infra_
- [ ] T-002 Write plan stub [P] _Boundary: plan-docs_
- [ ] T-003 Implement auth service [P] _Boundary: auth_ _Depends: T-001_
- [ ] T-004 Write auth tests _Boundary: auth-tests_ _Depends: T-003_
`
    const dir = path.join(worktree, "specs", "001-demo")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "tasks.md"), tasksMd, "utf-8")

    const content = await fs.readFile(path.join(dir, "tasks.md"), "utf-8")
    const parallelBounds: string[] = []
    for (const line of content.split("\n")) {
      if (!line.includes("[P]")) continue
      const m = line.match(/_Boundary:\s*([A-Za-z0-9-]+)_/)
      if (m) parallelBounds.push(m[1])
    }
    expect(parallelBounds).toEqual(["infra", "plan-docs", "auth"])
    expect(new Set(parallelBounds).size).toBe(parallelBounds.length)
  })

  it("extracts _Depends: references and detects a DAG (no self-dependency)", async () => {
    const tasksMd = `# Tasks
- [ ] T-001 Do first _Boundary: infra_
- [ ] T-002 Do second _Boundary: auth_ _Depends: T-001_
- [ ] T-003 Do third _Boundary: auth_ _Depends: T-002_
`

    const planDir = path.join(worktree, "specs", "001-demo")
    await fs.mkdir(planDir, { recursive: true })
    await fs.writeFile(path.join(planDir, "tasks.md"), tasksMd, "utf-8")

    const content = await fs.readFile(path.join(planDir, "tasks.md"), "utf-8")
    const deps = content.match(/_Depends:\s*T-(\d+)/g) ?? []
    const taskIds = content.match(/T-(\d+)/g) ?? []

    const dependsMap: Record<string, string[]> = {}
    for (const line of content.split("\n")) {
      const taskMatch = line.match(/T-(\d+)/)
      const depMatch = line.match(/_Depends:\s*T-(\d+)/)
      if (taskMatch && depMatch) {
        dependsMap[taskMatch[1]] = [...(dependsMap[taskMatch[1]] ?? []), depMatch[1]]
      }
    }

    // No task should depend on itself
    for (const [task, depsOf] of Object.entries(dependsMap)) {
      expect(depsOf).not.toContain(task)
    }
    expect(deps.length).toBeGreaterThan(0)
  })

  it("flags boundary overlap between tasks", async () => {
    const tasksMd = `# Tasks
- [ ] T-001 Do first _Boundary: shared_
- [ ] T-002 Do second _Boundary: shared_
`

    const planDir = path.join(worktree, "specs", "001-demo")
    await fs.mkdir(planDir, { recursive: true })
    await fs.writeFile(path.join(planDir, "tasks.md"), tasksMd, "utf-8")

    const content = await fs.readFile(path.join(planDir, "tasks.md"), "utf-8")
    const names = [...content.matchAll(/_Boundary:\s*([A-Za-z0-9-]+)_/g)].map((m) => m[1] ?? "")

    const duplicates = names.filter((n, i, arr) => arr.indexOf(n) !== i)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toBe("shared")
  })
})
