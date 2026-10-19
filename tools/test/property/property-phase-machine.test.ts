import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import fs from "node:fs/promises"
import path from "node:path"
import scaffoldTool from "../../speckit-scaffold"
import approveTool from "../../speckit-approve"
import phaseTool from "../../speckit-phase"
import validateTool from "../../speckit-validate"
import { createConstitution, createTempWorktree, destroyTempWorktree, mockContext } from "../helpers/setup"
import { detectPhase, exists, readSession, readSpecJson, specJsonPath, specsDirPath } from "../../shared/types"
import { SessionStateSchema, SpecJsonSchema } from "../../shared/schemas"

const FEATURE_NAME = "Test Feature"
const FEATURE_DIR = "001-test-feature"

type ArtifactName = "spec" | "plan" | "tasks"
type StoredPhase = "spec" | "plan" | "tasks" | "ready" | "impl" | "complete"
type MockToolContext = ReturnType<typeof mockContext>

// Holds the workflow state that every command updates before the real files are compared against it.
class PhaseModel {
  started = false
  artifacts: Record<ArtifactName, boolean> = { spec: false, plan: false, tasks: false }
  approvals: Record<ArtifactName, boolean> = { spec: false, plan: false, tasks: false }
  storedPhase: StoredPhase | null = null
  sessionPhase: StoredPhase | null = null
}

// Computes the phase and mismatch that validate must report from the stored phase and the artifacts on disk.
function expectedValidate(model: PhaseModel): { phase: StoredPhase; mismatch: boolean } {
  const { spec, plan, tasks } = model.artifacts
  const all = spec && plan && tasks
  const stored = model.storedPhase as StoredPhase
  let mismatch = false
  if (stored === "ready" && !all) mismatch = true
  else if (stored === "spec" && (!spec || plan || tasks)) mismatch = true
  else if (stored === "plan" && !plan) mismatch = true
  else if (stored === "tasks" && !tasks) mismatch = true
  else if ((stored === "impl" || stored === "complete") && !all) mismatch = true
  const phase = mismatch ? detectPhase(spec, plan, tasks, true).phase : stored
  return { phase: phase as StoredPhase, mismatch }
}

// Creates one throwaway project lazily so every model run talks to the real tools over a real filesystem.
class PhaseReal {
  private ready: Promise<{ root: string; ctx: MockToolContext }> | null = null

  prepare(): Promise<{ root: string; ctx: MockToolContext }> {
    if (!this.ready) {
      this.ready = (async () => {
        const root = await createTempWorktree()
        await createConstitution(root)
        return { root, ctx: mockContext(root) }
      })()
    }
    return this.ready
  }

  async dispose(): Promise<void> {
    if (!this.ready) return
    const { root } = await this.ready
    await destroyTempWorktree(root)
  }
}

// Compares the real spec.json, session.json and artifact files against the model after every command.
async function assertMachineState(model: PhaseModel, real: PhaseReal, action: string): Promise<void> {
  const { root } = await real.prepare()
  const session = await readSession(root)
  expect(SessionStateSchema.safeParse(session).success, `${action}: session.json stays schema valid`).toBe(true)
  if (!model.started) return

  expect(session.featureDir, `${action}: session tracks the new feature`).toBe(FEATURE_DIR)
  expect(session.phase, `${action}: session phase`).toBe(model.sessionPhase)

  const featureDir = path.join(specsDirPath(root), FEATURE_DIR)
  const sj = await readSpecJson(featureDir)
  expect(sj, `${action}: spec.json exists`).not.toBeNull()
  expect(SpecJsonSchema.safeParse(sj).success, `${action}: spec.json stays schema valid`).toBe(true)
  const state = sj as NonNullable<typeof sj>
  expect(state.phase, `${action}: stored phase`).toBe(model.storedPhase)
  expect(state.approvals.spec.approved, `${action}: spec approval`).toBe(model.approvals.spec)
  expect(state.approvals.plan.approved, `${action}: plan approval`).toBe(model.approvals.plan)
  expect(state.approvals.tasks.approved, `${action}: tasks approval`).toBe(model.approvals.tasks)
  // The tool gate only advances a ready feature, so the stored phase and the ready flag can never contradict the approvals.
  expect(state.ready_for_implementation, `${action}: ready flag mirrors the tasks approval`).toBe(model.approvals.tasks)
  if (state.phase === "impl" || state.phase === "complete") {
    expect(model.approvals.tasks, `${action}: impl and complete require the tasks approval`).toBe(true)
  }
  for (const artifact of ["spec", "plan", "tasks"] as const) {
    expect(
      await exists(path.join(featureDir, `${artifact}.md`)),
      `${action}: ${artifact}.md existence`,
    ).toBe(model.artifacts[artifact])
  }
}

class ScaffoldSpecCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return !model.started
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    const result = await scaffoldTool.execute({ featureName: FEATURE_NAME, template: "spec" }, ctx)
    expect((result.metadata as { featureDir?: string } | undefined)?.featureDir).toBe(FEATURE_DIR)
    model.started = true
    model.artifacts.spec = true
    model.storedPhase = "spec"
    model.sessionPhase = "spec"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "scaffold spec"
  }
}

class ScaffoldPlanCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return model.started && !model.artifacts.plan
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    await scaffoldTool.execute({ featureName: FEATURE_NAME, template: "plan" }, ctx)
    model.artifacts.plan = true
    model.storedPhase = "plan"
    model.sessionPhase = "plan"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "scaffold plan"
  }
}

class ScaffoldTasksCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return model.started && !model.artifacts.tasks
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    await scaffoldTool.execute({ featureName: FEATURE_NAME, template: "tasks" }, ctx)
    model.artifacts.tasks = true
    model.storedPhase = "tasks"
    model.sessionPhase = "tasks"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "scaffold tasks"
  }
}

class ApproveCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  constructor(private artifact: ArtifactName) {}

  check(model: Readonly<PhaseModel>): boolean {
    return model.started && model.artifacts[this.artifact] && !model.approvals[this.artifact]
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    const result = await approveTool.execute({ artifact: this.artifact, confirmed: true }, ctx)
    expect(result.title).toBe(`${this.artifact} approved`)
    model.approvals[this.artifact] = true
    // Approving tasks is the only approval that moves the stored state, while the session cache changes later.
    if (this.artifact === "tasks") model.storedPhase = "ready"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return `approve ${this.artifact}`
  }
}

class ImplCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return model.storedPhase === "ready" && model.approvals.tasks
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    const result = await phaseTool.execute({ phase: "impl" }, ctx)
    expect(result.title).toBe("Phase: impl")
    model.storedPhase = "impl"
    model.sessionPhase = "impl"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "phase impl"
  }
}

class CompleteCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return model.storedPhase === "impl"
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { ctx } = await real.prepare()
    const result = await phaseTool.execute({ phase: "complete" }, ctx)
    expect(result.title).toBe("Phase: complete")
    model.storedPhase = "complete"
    model.sessionPhase = "complete"
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "phase complete"
  }
}

class ValidateCommand implements fc.AsyncCommand<PhaseModel, PhaseReal> {
  check(model: Readonly<PhaseModel>): boolean {
    return model.started
  }

  async run(model: PhaseModel, real: PhaseReal): Promise<void> {
    const { root, ctx } = await real.prepare()
    const featureDir = path.join(specsDirPath(root), FEATURE_DIR)
    const expected = expectedValidate(model)
    const before = await fs.readFile(specJsonPath(featureDir), "utf-8")

    const result = await validateTool.execute({ featureDir: FEATURE_DIR }, ctx)

    const metadata = result.metadata as { phase?: string; specJsonPhase?: string; mismatch?: boolean }
    expect(metadata.specJsonPhase, `${this.toString()}: reported spec.json phase`).toBe(model.storedPhase)
    expect(metadata.mismatch, `${this.toString()}: reported mismatch`).toBe(expected.mismatch)
    expect(metadata.phase, `${this.toString()}: reported phase`).toBe(expected.phase)
    // Reading the state must never rewrite spec.json, only the session cache follows the computed phase.
    const after = await fs.readFile(specJsonPath(featureDir), "utf-8")
    expect(after, `${this.toString()}: spec.json bytes untouched`).toBe(before)
    model.sessionPhase = expected.phase
    await assertMachineState(model, real, this.toString())
  }

  toString(): string {
    return "validate"
  }
}

const allCommands: fc.Arbitrary<fc.AsyncCommand<PhaseModel, PhaseReal>>[] = [
  fc.constant(new ScaffoldSpecCommand()),
  fc.constant(new ScaffoldPlanCommand()),
  fc.constant(new ScaffoldTasksCommand()),
  fc.constant(new ApproveCommand("spec")),
  fc.constant(new ApproveCommand("plan")),
  fc.constant(new ApproveCommand("tasks")),
  fc.constant(new ImplCommand()),
  fc.constant(new CompleteCommand()),
  fc.constant(new ValidateCommand()),
]

describe("property: phase machine", () => {
  it("keeps spec.json, session.json and the artifacts coherent across generated command sequences", { timeout: 180_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(allCommands, { maxCommands: 12 }),
        async (commands) => {
          const real = new PhaseReal()
          try {
            await fc.asyncModelRun(() => ({ model: new PhaseModel(), real }), commands)
          } finally {
            await real.dispose()
          }
        },
      ),
      { numRuns: 12 },
    )
  })

  it("replays the tasks without plan order deterministically", { timeout: 60_000 }, async () => {
    const real = new PhaseReal()
    try {
      const model = new PhaseModel()
      const commands = [
        new ScaffoldSpecCommand(),
        new ScaffoldTasksCommand(),
        new ApproveCommand("tasks"),
        new ImplCommand(),
        new ValidateCommand(),
      ]
      for (const command of commands) {
        expect(command.check(model), `${command.toString()} fits the generated state`).toBe(true)
        await command.run(model, real)
      }
      expect(model.storedPhase).toBe("impl")
    } finally {
      await real.dispose()
    }
  })
})
