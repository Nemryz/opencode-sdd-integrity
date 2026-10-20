---
name: speckit-archiver
description: Archive a completed feature. Use when implementation is finished and verified, to move the feature to archive/ and update living specs.
license: MIT
compatibility: opencode
metadata:
  phase: "6"
  workflow: sdd
---

## What I do

Archive a completed feature by moving its directory from `specs/` to `archive/`, recording the archive date, and updating any living spec indexes. I ensure the feature is complete before archiving and verify the move succeeded.

## When to use me

Use after `/impl` and `/converge` (if used) when the feature is marked complete. Use `/archive` to trigger this skill.

## How to use me

### Step 0: Phase Gate

Before archiving, verify:
- `spec.json` exists and `phase` is `"complete"`
- If `converged` field exists and is `false`, warn the user and ask for confirmation
- All artifacts (spec.md, plan.md, tasks.md) exist

If any gate fails, tell the user what's needed and stop.

### Step 1: Determine Archive Path

1. Get current date: `YYYY-MM-DD`
2. Get feature dir name: `NNN-slug`
3. Archive path: `archive/YYYY-MM-DD-NNN-slug`
4. If `archive/YYYY-MM-DD-NNN-slug` already exists, append counter: `archive/YYYY-MM-DD-NNN-slug-2`

### Step 2: Create Archive Directory

1. Create `archive/` if it doesn't exist
2. Create `archive/YYYY-MM-DD-NNN-slug/` directory

### Step 3: Move Files

Move all files from `specs/NNN-slug/` to `archive/YYYY-MM-DD-NNN-slug/`:
- spec.md
- plan.md
- tasks.md
- spec.json (update with `archived_at`)
- evidence.json (if exists)
- research.md, data-model.md, contracts/, deltas/ (if exist)

### Step 4: Update spec.json

Set `archived_at` to current UTC timestamp in the archived spec.json.

### Step 5: Update Living Specs (if applicable)

If `specs/index.md` exists:
- Add entry: `- [NNN-slug](archive/YYYY-MM-DD-NNN-slug/) — archived YYYY-MM-DD`
- Remove from active features list (if present)

If `.opencode/spec-memory/session.json` references this feature:
- Update `featureDir` to null or next active feature

### Step 6: Verify

1. Verify all files exist in archive path
2. Verify original `specs/NNN-slug/` is empty or removed
3. Report success with archive path

### Step 7: Hand off

Tell the user: "Feature archived to `archive/YYYY-MM-DD-NNN-slug/`. Run `/status` to see updated state. Run `/spec <description>` to start a new feature."

## Rules

- Do NOT archive a feature that is not complete
- Do NOT delete files — move them
- If archive path collision, append counter
- Verify the move succeeded before reporting success
- Do not modify spec content during archiving (only add `archived_at`)
- The archive is permanent — suggest git commit after archiving