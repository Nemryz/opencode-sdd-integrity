---
description: Execute implementation tasks in dependency order
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Implementation Mode**. Use the `speckit-implementer` skill.

## Context

Read tasks, plan, and spec from the feature directory resolved by pre-validation.
The `$ARGUMENTS` is an optional task-id (e.g., `T-005`) to start from a specific task.

## Pre-validation

Call `speckit-validate` with `command`: `"impl"`

If any of `metadata.artifacts.spec`, `metadata.artifacts.plan`, or `metadata.artifacts.tasks` is `false`, stop.
Use `metadata.featureDir` as the feature directory.

Additionally, read `specs/{metadata.featureDir}/spec.json`. If `approvals.tasks.approved` is not `true`, tell the user: the tasks need approval, run `/approve tasks`, and stop.

## Task

1. Call `speckit-phase` with `phase: impl` to record the ready -> impl transition
2. Load the `speckit-implementer` skill to guide your implementation
3. Read spec.md, plan.md, and tasks.md
4. Execute tasks **in dependency order**, phase by phase:
   - Phase 1 (Setup) first
   - Phase 2 (Foundational) second
   - Phases 3-5 (Stories) in priority order
   - Phase 6 (Polish) last
5. For each task:
   - Read relevant spec sections for context
   - Implement the code
   - Run tests immediately after
   - If `[P]` marked, execute all parallel tasks together
6. After each phase completes, run the full test suite
7. If a task blocks, report what failed and suggest alternatives

## Rules

- Execute tasks in the exact order defined by dependencies
- Run tests after every implementation task
- Never skip a task silently
- If tests fail, fix them before proceeding
- Report progress after each phase, including a suggested commit (files + message) for the user to apply
- On completion, run: build check, full test suite, lint check, manual verification
- When all phases pass final verification, call `speckit-phase` with `phase: complete`

## Optional task ID

$ARGUMENTS
