---
name: speckit-converger
description: Verify implementation matches specification. Use after /impl to check convergence — whether all acceptance criteria are met and tests pass.
license: MIT
compatibility: opencode
metadata:
  phase: "5"
  workflow: sdd
  shared-rules: spec-writing.md
---

## What I do

Verify that the implementation matches the specification. I check every acceptance criterion against the code, run the test suite, and report whether the feature has "converged" (all criteria met) or not (with specific gaps and suggested fixes).

## When to use me

Use after `/impl` completes. Use when you want to verify that the implementation is correct before declaring a feature done. Use iteratively: /impl → /converge → fix → /converge → ... until "Converged".

## How to use me

### Step 0: Phase Gate

Before starting, verify that spec, plan, and tasks exist and are approved. Call `speckit-validate` with `command`: `"impl"`.

If validation fails, tell the user which artifacts are missing and stop.

### Step 1: Load Context

Read all available artifacts:
- `specs/<NNN>-<slug>/spec.md` — the specification (acceptance criteria, edge cases, user stories)
- `specs/<NNN>-<slug>/plan.md` — the technical plan
- `specs/<NNN>-<slug>/tasks.md` — the task breakdown
- `specs/<NNN>-<slug>/evidence.json` — test evidence per task
- `specs/<NNN>-<slug>/spec.json` — feature state and approvals

### Step 2: Extract Acceptance Criteria

From spec.md, extract:
1. All user stories (P1, P2, P3) with their acceptance criteria (Given/When/Then)
2. All edge cases listed
3. All success metrics

### Step 3: Check Implementation

For each acceptance criterion:
1. Find the corresponding code (search the codebase)
2. Find the corresponding test (search test files)
3. Determine status:
   - **PASS**: criterion is implemented and tested
   - **FAIL: no test**: criterion is implemented but no test exists
   - **FAIL: test failing**: test exists but fails
   - **FAIL: not implemented**: criterion is not implemented

### Step 4: Run Tests

Execute the project's test command:
- Record exit code
- Record pass/fail counts
- Note any failures

### Step 5: Check Evidence

From evidence.json:
- Count tasks with recorded evidence
- Count tasks without evidence
- Check if all tasks have passing tests

### Step 6: Produce Convergence Report

**If all criteria pass:**
```
CONVERGED: All N acceptance criteria verified.

Summary:
- User stories: X of Y verified (P1: A/B, P2: C/D, P3: E/F)
- Edge cases: W checked
- Tests: T passed, F failed
- Evidence: Z tasks with recorded evidence
- Tasks: all complete

The feature is ready for /archive.
```

**If any criterion fails:**
```
NOT CONVERGED: M of N criteria not met.

Gaps:
1. [US-001/AC-2]: "Given X, When Y, Then Z" — test failing in tests/foo.test.ts:42
2. [US-002/AC-1]: "Given A, When B, Then C" — not implemented (missing in src/bar.ts)
3. [Edge case 3]: no test found

Suggested fixes:
1. Fix assertion in tests/foo.test.ts:42 — expected "foo" but got "bar"
2. Implement AC-1 in src/bar.ts — add handler for condition B
3. Add test for edge case 3 in tests/edge.test.ts

Next: fix the gaps, then run /converge again.
```

### Step 7: Update spec.json

Set `converged` to true/false and append to `convergenceHistory`:
```json
{
  "converged": true,
  "convergenceHistory": [
    { "date": "2026-10-20T...", "status": "converged", "gaps": 0 },
    { "date": "2026-10-19T...", "status": "not-converged", "gaps": 3 }
  ]
}
```

### Step 8: Hand off

If converged: "Feature converged. Run `/archive` to archive it, or `/review` for a final cross-artifact check."

If not converged: "Not converged. Fix the gaps above, then run `/converge` again. You can also run `/impl` to re-implement specific tasks."

## Rules

- Do NOT modify implementation code — only report
- Run tests but do not fix failures (suggest fixes instead)
- Be specific about gaps — name the criterion, the file, and the line
- If all tests pass and all criteria are met, declare "CONVERGED"
- If not converged, provide actionable suggestions for each gap
- The user can run `/impl` again to fix issues, then `/converge` to re-check
- P1 stories must all pass for convergence; P2/P3 gaps are warnings, not blockers
- Every `[NEEDS CLARIFICATION]` must be resolved before declaring converged