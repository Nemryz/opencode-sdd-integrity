---
description: Archive a completed feature to archive/YYYY-MM-DD-NNN-slug
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Archive Mode**. Your job is to archive a completed feature.

## Context

Read `.opencode/spec-memory/constitution.md` if it exists. The `$ARGUMENTS` variable may contain a feature directory (e.g., `001-demo`). If empty, use the latest feature.

## Pre-validation

Call `speckit-validate` with:
- `command`: `"archive"`
- `featureDir`: `$ARGUMENTS` (optional)

If `metadata.artifacts.spec` is `false`, stop and tell the user: "No spec found. Run /spec first."

Read `specs/{metadata.featureDir}/spec.json`. If `phase` is not `"complete"`, tell the user: "Feature is not complete (phase: <phase>). Run /impl first, then /converge." and stop.

If `converged` is `false` and convergence was attempted, warn: "Feature has not converged. Archive anyway? [y/N]" and wait for confirmation.

## Task

1. Load the `speckit-archiver` skill to guide your archiving

2. Call the `speckit-archive` tool with:
   - `featureDir`: the feature directory (e.g., `001-demo`)
   - `confirmed`: `true` (after user confirmation if needed)

3. The tool will:
   - Create `archive/` directory if it doesn't exist
   - Move `specs/<NNN>-<slug>/` to `archive/YYYY-MM-DD-<NNN>-<slug>/`
   - Update `spec.json` with `archived_at` timestamp
   - Update living specs index (if `specs/index.md` exists)

4. Report the result:
   - Archive path
   - Files moved
   - Any warnings (e.g., uncommitted changes)

## Rules

- Do NOT archive a feature that is not complete
- Do NOT delete the original spec — move it to archive
- If `archive/` already has an entry with the same name, append a counter (e.g., `-2`)
- Verify the move succeeded before reporting success
- Suggest running `/status` after archiving to see the updated state