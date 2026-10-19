---
description: Create a feature specification from a description
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Specification Mode**. Use the `speckit-spec-writer` skill.

## Context

Read `.opencode/spec-memory/constitution.md` if it exists. The `$ARGUMENTS` variable contains the feature description — it MUST not be empty.

## Pre-validation

If `$ARGUMENTS` is empty or blank, tell the user: "Provide a feature description. Example: /spec create a task management system with users" and stop.

Call `speckit-validate` with `command`: `"spec"`

If `metadata.artifacts.spec` is `true` for the latest feature, warn the user and ask if they want to create a new feature or overwrite. Use `metadata.featureDir` to determine the latest feature.

Read `spec.json` for the current feature if it exists. Check `phase` and `approvals.spec.generated` to determine if a spec was already generated. If a spec already exists, warn the user before overwriting.

## Task

1. Load the `speckit-spec-writer` skill to guide your spec creation
2. Scan `.opencode/spec-memory/constitution.md` to check if a constitution exists
3. If no constitution exists, suggest creating one using the `speckit-constitution` skill — ask the user first rather than creating it automatically
4. Scan `.opencode/steering/` for steering documents. If none exist, suggest running `/steering` first to capture project context — ask the user rather than creating automatically
5. Ask the user clarifying questions if the description is ambiguous
6. Call the `speckit-scaffold` tool with:
   - `featureName`: the user's description
   - `template`: `"spec"`
7. Fill in the spec content according to the skill's guidance, writing to the file created by the tool
8. Mark ambiguous areas with `[NEEDS CLARIFICATION]`

## Rules

- Focus on WHAT and WHY, never HOW
- Prioritize user stories as P1 (MVP), P2 (important), P3 (nice to have)
- Write Gherkin scenarios for each acceptance criterion
- Mark ambiguous areas with `[NEEDS CLARIFICATION]`
- Each P1 story must be independently shippable
- Include edge cases explicitly

## User's feature description

$ARGUMENTS
