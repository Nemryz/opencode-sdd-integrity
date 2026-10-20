---
name: speckit-discovery
description: Analyze project state and suggest the next action. Use when the user is unsure what to do next, has multiple features, or wants a project overview.
license: MIT
compatibility: opencode
metadata:
  phase: "0"
  workflow: sdd
---

## What I do

Act as a project router that analyzes the current state of an SDD project and recommends the next action. I read session state, constitution, and existing features to determine what the user should do next. I can also create a brief and roadmap for multi-feature projects.

## When to use me

Use when the user asks "what should I do next?", "where am I?", or "what's the status?". Use when there are multiple incomplete features. Use at the start of a session to orient the user.

## How to use me

### Step 0: Gather State

Read all available project state:
- `.opencode/spec-memory/session.json` — current phase, feature, nextStep
- `.opencode/spec-memory/constitution.md` — governing principles (exists?)
- `.opencode/steering/` — steering documents (product, tech, structure)
- `specs/` — all feature directories with their spec.json

### Step 1: Analyze State

Determine the project's current state:

**No constitution:**
- If no specs exist: state = "fresh" → recommend `/spec <description>` or `/explore <idea>`
- If specs exist but no constitution: state = "missing-constitution" → recommend creating constitution first

**Active feature exists:**
- Read spec.json for phase, approvals, converged
- Determine next action based on phase and approvals

**Multiple features:**
- Count incomplete features
- If 2+ incomplete → suggest multi-spec mode

### Step 2: Route

Based on state analysis:

| State | Recommendation | Reason |
|---|---|---|
| No constitution, no features | `/spec <description>` or `/explore <idea>` | Start fresh |
| Constitution exists, no features | `/spec <description>` | Ready to specify |
| Active feature, no spec | `/spec <refined description>` | Need specification |
| Active feature, spec not approved | `/approve spec` then `/plan` | Spec needs approval |
| Active feature, spec approved, no plan | `/plan <tech stack>` | Need technical plan |
| Active feature, plan not approved | `/approve plan` then `/tasks` | Plan needs approval |
| Active feature, plan approved, no tasks | `/tasks` | Need task breakdown |
| Active feature, tasks not approved | `/approve tasks` then `/impl` | Tasks need approval |
| Active feature, ready | `/impl` | Ready to implement |
| Active feature, impl complete | `/converge` then `/archive` | Verify and archive |
| Multiple incomplete features | Multi-spec mode | Need coordination |

### Step 3: Multi-spec mode (if applicable)

If 2+ incomplete features exist:

1. Create `.opencode/spec-memory/brief.md`:
```markdown
# Project Brief

## Features
1. **001-feature-a** — [description] — Phase: spec — Status: in progress
2. **002-feature-b** — [description] — Phase: plan — Status: in progress

## Dependencies
- 002-feature-b depends on 001-feature-a (API contract)

## Priority
1. 001-feature-a (P1)
2. 002-feature-b (P2)
```

2. Create `.opencode/spec-memory/roadmap.md`:
```markdown
# Roadmap

## Phase 1 (current)
- [ ] 001-feature-a: spec → plan → tasks → impl

## Phase 2
- [ ] 002-feature-b: spec → plan → tasks → impl (depends on Phase 1)

## Completed
- (none yet)
```

3. Suggest: "Multi-spec mode activated. Run `/spec` for the next feature, or `/status` to see current progress."

### Step 4: Report

```
Discovery: <state summary>
  Features: N total (M complete, K in progress)
  Active: <feature-name> (phase: <phase>)
  Constitution: yes/no
  Steering: yes/no

Recommended: <action>
Reason: <why this action>
Next: <command>
```

### Step 5: Hand off

Tell the user the recommendation and wait for them to act. Do not create artifacts unless in multi-spec mode.

## Rules

- Do NOT create spec/plan/tasks artifacts — only suggest (except multi-spec brief/roadmap)
- Do NOT modify existing files — only read and report
- If multiple features are incomplete, suggest multi-spec mode
- Always explain WHY the recommendation is made
- If the user disagrees, ask what they want to do instead
- Read-only: this command never writes to specs/ directories