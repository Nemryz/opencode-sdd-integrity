---
name: speckit-explorer
description: Explore an idea before specification. Use when the user wants to think through requirements, clarify scope, or identify ambiguities before creating a spec.
license: MIT
compatibility: opencode
metadata:
  phase: "0"
  workflow: sdd
  shared-rules: spec-writing.md
---

## What I do

Act as a thinking partner to help the user explore an idea before committing to a specification. I ask clarifying questions, scan the codebase for relevant context, identify ambiguities and edge cases, and propose scope boundaries. I do NOT create any artifacts — I produce a summary that feeds into `/spec`.

## When to use me

Use before `/spec` when the idea is vague, complex, or involves significant unknowns. Use when the user says "I'm thinking about..." or "What if we..." or "Explore...".

## How to use me

### Step 0: Context Loading

Read all available project context:
- `.opencode/spec-memory/constitution.md` — governing principles
- `.opencode/steering/` — product, tech, structure documents
- Existing specs in `specs/` — to avoid duplication
- Codebase structure (via glob/grep) — to understand what exists

### Step 1: Understand the Idea

1. Read the user's description carefully
2. Identify the core problem being solved
3. Identify the target user(s)
4. Ask 2-3 clarifying questions if anything is ambiguous
5. Do NOT assume — ask

### Step 2: Scan the Codebase

1. Use `glob` to find relevant files (routes, models, components, tests)
2. Use `grep` to find existing patterns (similar features, API endpoints)
3. Read key files to understand conventions and architecture
4. Note what exists vs. what needs to be created

### Step 3: Identify Ambiguities

List every unclear, missing, or contradictory aspect:
- Mark each with `[NEEDS CLARIFICATION]`
- Group by: functional, technical, UX, data, security
- Prioritize: which must be resolved before spec, which can be deferred

### Step 4: Propose Scope Boundaries

For each potential user story:
- **P1 (MVP)**: Must ship for the feature to be useful
- **P2 (Important)**: Significantly improves the feature
- **P3 (Nice to have)**: Can be deferred without losing core value

Ask the user to confirm or adjust.

### Step 5: Identify Edge Cases

List edge cases, error scenarios, and boundary conditions:
- Empty states
- Concurrent access
- Invalid input
- Network failures
- Permission boundaries

### Step 6: Produce Summary

Write a concise exploration summary (under 500 words) to `.opencode/spec-memory/exploration.md`:

```markdown
---
feature_name: <idea>
created_at: <date>
status: explored
---

# Exploration: <idea>

## Idea
One-sentence description.

## Context
What exists in the codebase that's relevant.

## Clarifications needed
- [NEEDS CLARIFICATION] <item 1>
- [NEEDS CLARIFICATION] <item 2>

## Scope proposal
- P1: <story 1>, <story 2>
- P2: <story 3>
- P3: <story 4>

## Edge cases
- <edge case 1>
- <edge case 2>

## Suggested next step
/spec <refined description based on exploration>
```

### Step 7: Hand off

Tell the user: "Exploration complete. Run `/spec <refined description>` to create the specification, or continue exploring with more questions."

## Rules

- Do NOT create spec.md, plan.md, or tasks.md
- Do NOT write implementation code
- Focus on understanding, not solving
- Ask questions rather than assuming
- Keep the summary concise (under 500 words)
- The exploration summary is optional — if the user declines, skip writing it
- Each P1 story must be independently shippable
- Mark ambiguous areas with `[NEEDS CLARIFICATION]`