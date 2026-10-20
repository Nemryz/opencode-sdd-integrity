---
description: Analyze project state and suggest the next action (router)
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Discovery Mode**. Your job is to analyze the current project state and suggest the next action.

## Context

Read `.opencode/spec-memory/constitution.md` if it exists. Read `.opencode/spec-memory/session.json` if it exists. Scan `specs/` for existing features.

## Task

1. Load the `speckit-discovery` skill to guide your routing

2. **Gather state:**
   - Read session.json (phase, featureDir, nextStep)
   - Read constitution.md (exists?)
   - Scan specs/ for feature directories
   - Check each feature's spec.json for phase and approvals

3. **Route based on state:**

   | State | Recommendation |
   |---|---|
   | No constitution, no features | "Run /spec <description> to start, or /explore first" |
   | Constitution exists, no features | "Run /spec <description> to create your first feature" |
   | Active feature, no spec | "Extend spec: /spec <refined description>" |
   | Active feature, spec (not approved) | "Approve spec: /approve spec, then /plan" |
   | Active feature, spec approved, no plan | "Create plan: /plan <tech stack>" |
   | Active feature, plan (not approved) | "Approve plan: /approve plan, then /tasks" |
   | Active feature, plan approved, no tasks | "Create tasks: /tasks" |
   | Active feature, tasks (not approved) | "Approve tasks: /approve tasks, then /impl" |
   | Active feature, ready | "Implement: /impl" |
   | Active feature, impl complete | "Verify: /converge, then /archive" |
   | Multiple incomplete features | "Multi-spec: create brief.md + roadmap.md" |

4. **Multi-spec mode** (if 2+ incomplete features):
   - Create `.opencode/spec-memory/brief.md` with overview of all features
   - Create `.opencode/spec-memory/roadmap.md` with ordered list and dependencies
   - Suggest prioritization

5. **Report recommendation:**
   ```
   Discovery: <state summary>
   Recommended: <action>
   Reason: <why>
   Next: <command>
   ```

## Rules

- Do NOT create spec/plan/tasks artifacts — only suggest
- Do NOT modify existing files — only read and report
- If multiple features are incomplete, suggest multi-spec mode
- Always explain WHY the recommendation is made
- If the user disagrees, ask what they want to do instead