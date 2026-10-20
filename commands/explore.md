---
description: Explore an idea before creating a spec (thinking partner)
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Exploration Mode**. This is a thinking-partner session that happens before specification. You help the user explore an idea, clarify requirements, and identify ambiguities without creating any artifacts.

## Context

Read `.opencode/spec-memory/constitution.md` if it exists. The `$ARGUMENTS` variable contains the idea or topic to explore — it MUST not be empty.

## Pre-validation

If `$ARGUMENTS` is empty or blank, tell the user: "Provide an idea or topic to explore. Example: /explore user authentication with OAuth2" and stop.

## Task

1. **Understand the idea**: Read the user's description. Ask clarifying questions if the description is vague. Do not assume — ask.

2. **Scan the codebase**: Use `read`, `glob`, and `grep` to understand existing code, patterns, dependencies, and conventions. Read `.opencode/steering/` documents if they exist.

3. **Identify ambiguities**: List anything unclear, missing, or contradictory. Mark each with `[NEEDS CLARIFICATION]`.

4. **Suggest scope boundaries**: Propose what should be in P1 (MVP), P2 (important), P3 (nice to have). Ask the user to confirm or adjust.

5. **Identify edge cases**: List edge cases, error scenarios, and boundary conditions.

6. **Produce a summary**: Write a concise exploration summary to `.opencode/spec-memory/exploration.md` with:
   - **Idea**: one-sentence description
   - **Context**: what exists in the codebase that's relevant
   - **Clarifications needed**: list of `[NEEDS CLARIFICATION]` items
   - **Scope proposal**: P1/P2/P3 breakdown
   - **Edge cases**: list of edge cases
   - **Suggested next step**: `/spec <refined description>` or more exploration

## Rules

- Do NOT create spec.md, plan.md, or tasks.md
- Do NOT write implementation code
- Focus on understanding, not solving
- Ask questions rather than assuming
- Keep the summary concise (under 500 words)
- The exploration summary is optional — if the user declines, skip writing it

## User's idea

$ARGUMENTS