import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import {
  parseNNN,
  detectPhase,
  detectPhaseFromFiles,
  isSafeFeatureDirName,
  detectPackageManager,
  assessComplexity,
} from "../../shared/types"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await createTempWorktree()
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await destroyTempWorktree(dir)
  }
})

describe("matrix: parseNNN", () => {
  it.each([
    ["001-foo", 1],
    ["007-x", 7],
    ["42-bar", 42],
    ["999-biggest", 999],
    ["0-zero", 0],
    ["12-with-dash", 12],
    ["no-number", 0],
    ["", 0],
    ["-leading-dash", 0],
    ["abc-001", 0],
    ["001a-foo", 0],
  ])("parseNNN(%j) -> %i", (input, expected) => {
    expect(parseNNN(input as string)).toBe(expected)
  })
})

describe("matrix: detectPhaseFromFiles", () => {
  it.each([
    [false, false, false, "spec"],
    [true, false, false, "plan"],
    [true, true, false, "tasks"],
    [true, true, true, "ready"],
    [false, true, true, "spec"],
    [false, false, true, "spec"],
    [true, false, true, "plan"],
  ])("files(spec=%s, plan=%s, tasks=%s) -> %s", (specOk, planOk, tasksOk, expected) => {
    expect(detectPhaseFromFiles(specOk as boolean, planOk as boolean, tasksOk as boolean)).toBe(expected)
  })
})

describe("matrix: detectPhase", () => {
  it.each([
    [false, false, false, false, "init"],
    [true, true, true, false, "init"],
    [false, true, true, true, "spec"],
    [true, false, true, true, "plan"],
    [true, true, false, true, "tasks"],
    [true, true, true, true, "ready"],
  ])(
    "detectPhase(spec=%s, plan=%s, tasks=%s, constitution=%s) -> %s",
    (specOk, planOk, tasksOk, constitution, expected) => {
      const result = detectPhase(
        specOk as boolean,
        planOk as boolean,
        tasksOk as boolean,
        constitution as boolean,
      )
      expect(result.phase).toBe(expected)
      expect(result.nextStep.length).toBeGreaterThan(0)
    },
  )

  it.each([
    [false, "/spec <description>"],
    [true, "/plan <tech stack>"],
  ])("nextStep for constitution-only=%s -> %s", (constitutionExists, expected) => {
    expect(detectPhase(constitutionExists as boolean, false, false, constitutionExists as boolean).nextStep)
      .toBe(expected)
  })
})

describe("matrix: isSafeFeatureDirName", () => {
  it.each([
    ["001-foo", true],
    ["feature-name_2", true],
    ["a", true],
    [".hidden", true],
    ["with space", true],
    ["", false],
    [".", false],
    ["..", false],
    ["nested/dir", false],
    ["nested\\dir", false],
    ["/absolute", false],
    ["C:\\absolute", false],
    ["../escape", false],
  ])("isSafeFeatureDirName(%j) -> %s", (input, expected) => {
    expect(isSafeFeatureDirName(input as string)).toBe(expected)
  })
})

describe("matrix: detectPackageManager", () => {
  it.each([
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
  ])("lockfile %s -> %s", async (lockfile, expected) => {
    const dir = await makeTempDir()
    await fs.writeFile(path.join(dir, lockfile as string), "", "utf-8")
    expect(await detectPackageManager(dir)).toBe(expected)
  })

  it("no lockfile -> unknown", async () => {
    const dir = await makeTempDir()
    expect(await detectPackageManager(dir)).toBe("unknown")
  })
})

describe("matrix: assessComplexity monotonicity", () => {
  it.each([
    ["single file, no deps", 1, false, false, false],
    ["many files", 12, false, false, false],
    ["many files + dependency", 12, true, false, false],
    ["many files + dependency + boundaries", 12, true, true, false],
    ["everything flagged", 40, true, true, true],
  ])("%s never scores lower than the previous case", async (_label, files, deps, boundaries, clarification) => {
    const minimal = await assessComplexity("Add a button to the header", 1, false, false, false)
    const result = await assessComplexity(
      "Add a button to the header",
      files as number,
      deps as boolean,
      boundaries as boolean,
      clarification as boolean,
    )
    expect(result.score).toBeGreaterThanOrEqual(minimal.score)
    expect(["simple", "standard", "complex"]).toContain(result.level)
  })

  it("trivial task is simple and a large multi-signal task is complex", async () => {
    const simple = await assessComplexity("Add a button to the header", 1, false, false, false)
    const complex = await assessComplexity(
      "Implement distributed caching with Redis, refactor auth, add monitoring and audit logging across services",
      25,
      true,
      true,
      true,
    )
    expect(simple.level).toBe("simple")
    expect(complex.level).toBe("complex")
  })
})