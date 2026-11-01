import { describe, it, expect, afterEach } from "vitest"
import * as fc from "fast-check"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readRegistry } from "../../lab/core/registry"
import { safeLabEnvironment, deniedEnvironmentKeys } from "../../lab/core/environment"
import { isLabSandboxRoot } from "../../lab/core/home"
import { planDependencyAction } from "../../lab/core/dependencies"
import type { LabDependencyState } from "../../lab/core/types"

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("Fuzz: readRegistry never crashes on hostile bytes", () => {
  it("for every string written as registry.json, readRegistry either returns a registry or throws a readable error", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (content) => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fuzz-lab-"))
        const file = path.join(tmpDir, ".opencode", "lab", "registry", "registry.json")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content, "utf-8")
        let threw = false
        try {
          await readRegistry(tmpDir)
        } catch (error) {
          threw = true
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message.length).toBeGreaterThan(0)
        }
        // Either outcome is acceptable; the invariant is "no unhandled crash".
        expect(typeof threw).toBe("boolean")
        await fs.rm(tmpDir, { recursive: true, force: true })
      }),
      { numRuns: 60 },
    )
  })
})

describe("Fuzz: safeLabEnvironment never leaks a secret-shaped key", () => {
  it("for every parent env, denied keys never reach the child", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.string()),
        (parent) => {
          const child = safeLabEnvironment(parent, Object.keys(parent), {})
          const denied = new Set(deniedEnvironmentKeys(parent))
          for (const key of denied) {
            expect(child[key]).toBeUndefined()
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe("Fuzz: isLabSandboxRoot never throws on arbitrary strings", () => {
  it("for every pair of strings, returns a boolean", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (projectRoot, sandboxRoot) => {
        const result = isLabSandboxRoot(projectRoot, sandboxRoot)
        expect(typeof result).toBe("boolean")
      }),
      { numRuns: 500 },
    )
  })
})

describe("Fuzz: planDependencyAction never throws on hostile inputs", () => {
  it("for every combination of lockfile states, returns a decision", () => {
    const lockfileArb = fc.option(
      fc.record({
        file: fc.string({ minLength: 1, maxLength: 32 }),
        manager: fc.constantFrom("npm", "pnpm", "yarn", "bun") as fc.Arbitrary<"npm" | "pnpm" | "yarn" | "bun">,
        hash: fc.string({ minLength: 8, maxLength: 64 }),
      }),
      { nil: null },
    )
    const dependencyStateArb = fc.option(
      fc.record({
        strategy: fc.constantFrom("ready", "missing", "pending", "linked", "installed"),
        lockfile: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
        lockHash: fc.option(fc.string({ minLength: 8, maxLength: 64 }), { nil: undefined }),
        sourceLockfile: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
        sourceLockHash: fc.option(fc.string({ minLength: 8, maxLength: 64 }), { nil: undefined }),
        manager: fc.option(fc.constantFrom("npm", "pnpm", "yarn", "bun"), { nil: undefined }),
        updatedAt: fc.option(fc.string(), { nil: undefined }),
      }) as fc.Arbitrary<LabDependencyState>,
      { nil: undefined },
    )

    fc.assert(
      fc.property(
        lockfileArb,
        lockfileArb,
        dependencyStateArb,
        fc.boolean(),
        fc.boolean(),
        (source, sandbox, current, sandboxHasNodeModules, sourceHasNodeModules) => {
          const decision = planDependencyAction({
            source,
            sandbox,
            current,
            baseSource: source,
            sandboxHasNodeModules,
            sourceHasNodeModules,
          })
          expect(["ready", "error", "link", "install"]).toContain(decision.action)
          expect(typeof decision.reason).toBe("string")
        },
      ),
      { numRuns: 300 },
    )
  })
})
