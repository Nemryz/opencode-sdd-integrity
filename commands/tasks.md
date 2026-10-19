---
description: Break a plan into actionable implementation tasks
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Task Decomposition Mode**. Use the `speckit-task-decomposer` skill.

## Context

Read the spec and plan from the feature directory resolved by pre-validation.

## Pre-validation

Call `speckit-validate` with:
- `command`: `"tasks"`
- `featureDir`: `$ARGUMENTS` (the user optionally specifies a feature directory)

If `metadata.artifacts.spec` or `metadata.artifacts.plan` is `false`, stop and tell the user what's needed.
Use `metadata.featureDir` as the feature directory.

Additionally, read `specs/{metadata.featureDir}/spec.json`. If `approvals.plan.approved` is not `true`, tell the user: the plan needs approval, run `/approve plan`, and stop.

## Task

1. Load the `speckit-task-decomposer` skill to guide your decomposition
2. Read spec.md, plan.md, and any optional docs (research.md, data-model.md, contracts/)
3. Call the `speckit-scaffold` tool with:
   - `featureName`: the feature name (from session.json or latest spec dir)
   - `template`: `"tasks"`
4. Fill in the tasks content according to the skill's guidance, writing to the file created by the tool
5. Organize tasks into the 6-phase structure defined in `speckit-task-decomposer` (Setup → Foundational → P1 → P2 → P3 → Polish)
6. Mark parallelizable tasks with `[P]`
7. Include test tasks (write tests BEFORE implementation)
8. Build an ASCII dependency map
9. Verify each task has a clear file path or deliverable

## Rules

- Every user story from the spec must have at least one task
- Tests are separate tasks, ordered before implementation
- No task should be too large (split if > ~1 day of work)
- Setup phase must exist for infrastructure
- If a story has no implementation tasks, flag it
