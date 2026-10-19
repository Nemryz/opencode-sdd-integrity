---
name: speckit-implementer
description: Execute implementation tasks in dependency order, building and testing each phase. Use when tasks are approved and code execution begins.
license: MIT
compatibility: opencode
metadata:
  phase: "4"
  workflow: sdd
  shared-rules: design-principles.md, tasks-generation.md
---

## What I do

Execute implementation tasks sequentially, respecting dependencies and parallelization markers. Build, test, and verify each phase before moving to the next. Optionally dispatch sub-agents for TDD cycles with independent review.

## When to use me

Use when spec, plan, and tasks are all complete and approved. I implement the feature following the task list exactly.

## How to use me

### Step 0: Phase Gate

Before starting, call `speckit-audit` to detect existing project issues. If the audit reports errors, inform the user and resolve them before implementing.

Then read `specs/NNN-feature-name/spec.json` and verify:
- `approvals.tasks.approved === true` — tasks must be approved before implementation
- `phase` is `"tasks"` or `"ready"` — otherwise implementation has already started
- Run `git status --porcelain` to note pre-existing uncommitted changes
- Discover validation commands: check `package.json`, `Makefile`, `README*`, CI configs

If the gate fails, stop and tell the user what needs to happen first.

### Step 1: Load Context

Read all task documentation:
1. `tasks.md`, `plan.md`, `spec.md` from `specs/NNN-feature-name/`
2. Constitution from `.opencode/spec-memory/constitution.md`
3. Steering context from `.opencode/steering/` (if exists) — `product.md`, `tech.md`, `structure.md`
4. Domain map from `.opencode/domain-map.md` (if exists)
5. Shared rules from `skills/rules/design-principles.md` and `skills/rules/tasks-generation.md`
6. SDD configuration from `.opencode/spec-memory/config.json` — read `expressMode` and `defaultTechStack`

### Step 2: Complexity Routing (NEW)

Before proposing the plan, call `speckit-complexity` to assess each phase's complexity level. Use the information gathered in Step 1 to determine routing per task:

**simple**: Execute directly without sub-agents. Skip TDD if tests already exist. Single-file changes.
**standard**: Run full TDD cycle (RED → GREEN → REFACTOR). Use sub-agents only if boundary annotations exist.
**complex**: Dispatch `@explore` sub-agent first for research. Use `@speckit-implementer` and `@speckit-reviewer` sub-agents per boundary. Max 3 debug rounds instead of 2.

Include the assessed complexity in the proposal to set user expectations.

### Step 3: Conversational Proposal

Before executing any task, propose the implementation order to the user.

**Express Mode**: If the SDD configuration has `expressMode: true`, skip this step and proceed directly to execution with standard routing defaults.

Standard proposal format:

```
## Proposed Execution: <feature-name>

### Phase Plan
1. Setup — <infrastructure and dependencies>
2. Foundational — <core models and data layer>
3. P1: <Story 1> — <N tasks, TDD>
4. P2: <Story 2> — <M tasks, TDD>
5. Polish — <edge cases and cleanup>

### Boundary Map
- `_Boundary: Component A_` → T-001, T-002
- `_Boundary: Component B_` → T-003

### Confirmation
Does this execution order look right? I will start implementation after confirmation.
```

Wait for user confirmation before proceeding to Step 4.

### Step 4: Execute Tasks

Execute tasks in dependency order. For each task, apply the complexity-appropriate route determined in Step 2:

**Simple route**: Implement directly without TDD cycle. Skip sub-agents. Verify with existing tests.
**Standard route**: Follow full TDD cycle. Use sub-agents if boundary annotations exist.
**Complex route**: Dispatch `@explore` for research first. Use `@speckit-implementer` and `@speckit-reviewer` sub-agents per boundary. Max 3 debug rounds.

**Per-task flow (TDD cycle):**
1. **RED**: Read relevant spec sections. Write test for the next small piece. Test should fail.
2. **GREEN**: Implement simplest solution to make test pass.
3. **REFACTOR**: Improve code structure. All tests must still pass.
4. **VERIFY**: Run full test suite. Confirm no regressions.
5. **RECORD**: Call `speckit-evidence` with `command: "record"`, the task id, the exact test command and its exit code.

**Sub-agent dispatch (optional, for complex tasks):**
If a task is complex, dispatch sub-agents:
1. **`@speckit-implementer` sub-agent**: Writes code following TDD, respecting `_Boundary: ComponentName_` annotations
2. **`@speckit-reviewer` sub-agent**: Reviews code against spec, returns APPROVED/REJECTED
3. **`@explore` sub-agent** (for unknowns): Researches codebase patterns and returns findings
4. **Debugger sub-agent** (on rejection): Investigates root cause in fresh context

Use `_Boundary: ComponentName_` annotations from `tasks.md` to assign scope to each sub-agent. Clear ownership prevents overlap and merge conflicts.

Max 2 debug rounds per task. If still blocked after 2 rounds, report the blocked task and root cause in your summary (do NOT edit tasks.md — it is protected after approval).

**Commit suggestions per phase:**
- After each phase completes with green tests/lint/build, propose a commit to the user: list that phase's files and a suggested message `feat(<feature>): phase N — <summary>`
- Never run `git add -A` or `git add .`; stage only that phase's files
- If the repository has no commits yet, suggest an initial commit for the scaffold (package.json, configs, .gitignore) before the first phase commit
- Wait for the user's go-ahead before committing, unless the user asked you to commit automatically

### Step 5: Run Tests After Each Phase

After all tasks in a phase complete, run:
1. Build check
2. Full test suite
3. Lint check
4. Record the phase verification with `speckit-evidence`, using the phase label as the task value.

If tests fail, fix before proceeding to the next phase.

### Step 6: Completion metadata

After the final verification passes, call the `speckit-phase` tool with `phase: complete` to record the transition from impl. Do NOT edit `specs/NNN-feature-name/spec.json` manually — the file protection guard blocks it (AGENTS.md rule 8); phase and `updated_at` are managed by the suite tools (`speckit-scaffold`, `speckit-approve`, `speckit-phase`). Then report completion and suggest `/review`.

### Step 7: Final Verification

After all phases complete:
1. Run full test suite (final)
2. Build check
3. Lint check
4. Manual verification of feature behavior

## Execution rules

### Task order
Follow the 6-phase structure: Setup → Foundational → P1 → P2 → P3 → Polish.
Within a phase, respect the dependency DAG. Run `[P]` tasks concurrently.

### Test discipline
- Tests MUST be run after each implementation task
- Every verification run MUST be recorded with `speckit-evidence` so the audit can prove it happened
- Record failing runs too, then record the green rerun that resolved them
- If tests fail, fix before proceeding
- If no test task exists for a story, flag this as a risk

### Error handling
- If a task cannot be completed, report what was done and what blocked it
- Suggest alternative approaches for blocked tasks
- Never skip a task silently

## Safety & Fallback

### Error: Task blocked after 2 debug rounds
- **Stop**: Report the task as `_Blocked: <reason>_` in your summary (tasks.md is protected after approval; do not edit it)
- **Recovery**: Report to user with root cause analysis. Human intervention required.

### Error: Tests fail after implementation
- **Stop**: Do not proceed to next task
- **Recovery**: Fix test or implementation. Re-run until green.

### Error: Boundary overlap between sub-agents
- **Stop**: Two sub-agents claim the same `_Boundary:_` annotation
- **Recovery**: Reassign boundaries in main context, dispatch sequentially for overlapping areas

### Error: Sub-agent dispatch unavailable
- **Fallback**: Execute TDD sequentially in main context
- **Recovery**: Report that sub-agent dispatch is unavailable, proceed with inline implementation

### Error: Pre-existing uncommitted changes detected
- **Warning**: Do not commit unowned changes
- **Recovery**: Stash or note pre-existing changes. Only stage files for current task.

## Quality checklist

- [ ] Pre-validated by command layer before skill invocation
- [ ] Complexity routing assessed before execution
- [ ] Correct route followed per task (simple/standard/complex)
- [ ] Express Mode checked before conversational proposal
- [ ] Conversational proposal made (or skipped in auto or express mode)
- [ ] Shared rules loaded from `skills/rules/`
- [ ] Tasks executed in correct dependency order
- [ ] Boundary annotations (`_Boundary:_`) respected during dispatch
- [ ] `@mention` syntax used for sub-agent dispatch
- [ ] Tests pass after each phase
- [ ] Test evidence recorded after every task and phase
- [ ] Parallel tasks executed together
- [ ] Blocked tasks reported with alternatives
- [ ] Final verification run on completion
- [ ] No task skipped silently
- [ ] TDD cycle followed (RED → GREEN → REFACTOR)
- [ ] Selective git commit (no `git add .`)
- [ ] Debug rounds capped at 2 per task

## Reference

Tasks: `specs/NNN-feature-name/tasks.md`
Plan: `specs/NNN-feature-name/plan.md`
Spec: `specs/NNN-feature-name/spec.md`
Constitution: `.opencode/spec-memory/constitution.md`
Shared rules: `skills/rules/design-principles.md`, `skills/rules/tasks-generation.md`
Boundary map: `specs/NNN-feature-name/tasks.md` — look for `_Boundary: ComponentName_` annotations
Sub-agents: `@speckit-implementer`, `@speckit-reviewer`, `@explore`

## Verification

After completion, run:
1. Build check
2. Full test suite
3. Lint check
4. Manual verification of the feature behavior
