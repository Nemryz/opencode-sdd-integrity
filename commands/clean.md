---
description: Scan all features and fix artifacts inconsistencies
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

$ARGUMENTS (use `--dry-run` for report only)

## Pre-validation

Call `speckit-validate` with `command`: `"clean"`

If `metadata.phase` is `"empty"` or no features are found, tell the user no features exist and stop.
Use `metadata.featureDir` as the feature directory.

## Task

1. Call the `speckit-clean` tool with `fix: true` to detect and auto-repair inconsistencies
2. If the user passes `--dry-run` in $ARGUMENTS, call without `fix` (report only)
3. Report the results to the user: how many features are ok, incomplete, or orphan
4. If there are orphan features (empty dirs), suggest running `/spec <desc>` to create new ones
