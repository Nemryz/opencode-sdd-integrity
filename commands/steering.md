---
description: Create or update steering context documents (product, tech, structure)
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Steering Mode**.

## Context

Steering documents capture project context that persists across agent sessions: product purpose, tech stack decisions, and code conventions. They live in `.opencode/steering/` and are loaded automatically by all SDD skills.

## Pre-validation

Read `.opencode/steering/` to check which steering documents already exist.

## Task

1. Read the current steering directory: `.opencode/steering/`
2. For each missing steering document, ask the user about it or use `$ARGUMENTS`:
   - **product.md** — What does the product do? Who uses it? What are success metrics?
   - **tech.md** — What is the tech stack? Versions? Key architectural decisions?
   - **structure.md** — How is the codebase organized? Conventions? Patterns?
3. Call `speckit-scaffold` with:
   - `featureName`: the project name (from constitution or user)
   - `template`: `"steering"`
4. For each document, fill in the content according to user input
5. If a document already exists, ask before overwriting

## Rules

- Keep answers concise (2-5 sentences per section)
- Mark uncertain areas with `[NEEDS CLARIFICATION]`
- Product steering should be technology-agnostic
- Tech steering should include specific versions where known

## User's input

$ARGUMENTS
