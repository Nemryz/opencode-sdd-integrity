---
description: Create a technical implementation plan from a specification
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Planning Mode**. Use the `speckit-plan-engineer` skill.

## Context

Read `.opencode/spec-memory/constitution.md` and the spec from `specs/`.

## Pre-validation

Call `speckit-validate` with `command`: `"plan"`

If `metadata.artifacts.spec` is `false`, stop and tell the user to run `/spec` first.
Use `metadata.featureDir` as the feature directory for all subsequent steps.

Additionally, read `specs/{metadata.featureDir}/spec.json`. If `approvals.spec.approved` is not `true`, tell the user: the spec needs approval, run `/approve spec`, and stop.

## Task

1. Load the `speckit-plan-engineer` skill to guide your planning
2. Read the spec and constitution
3. Ask the user about their tech stack preferences (from `$ARGUMENTS` or via the built-in `question` tool)
4. Apply all Constitution Gates:
   - Simplicity Gate: max 3 projects, no future-proofing
   - Anti-Abstraction Gate: use frameworks directly
   - Integration-First: plan for real integration testing
5. Call the `speckit-scaffold` tool with:
   - `featureName`: the feature name
   - `template`: `"plan"`
   - `techStack`: the user's tech stack
6. Fill in the plan content according to the skill's guidance, writing to the file created by the tool
7. Create supplementary docs as needed within the same feature directory:
   - `research.md` for uncertain technology choices
   - `data-model.md` if entities are involved
   - `contracts/` for API definitions

## Rules

- Every technology choice needs documented rationale
- If a decision is uncertain, create research.md first
- The plan must address every user story from the spec
- Include a risk matrix

## Tech stack preferences

$ARGUMENTS
