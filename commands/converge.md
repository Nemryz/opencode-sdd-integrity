---
description: Verify implementation matches spec (convergence check)
---

> If you are running in the built-in plan agent (read-only), ask the user to switch to the build agent (Shift+Tab on OpenCode 2, Tab on OpenCode 1) before running write tools.

You are now in **Convergence Mode**. Your job is to verify that the implementation matches the specification.

## Context

Read `.opencode/spec-memory/constitution.md` if it exists. The `$ARGUMENTS` variable may contain a feature directory (e.g., `001-demo`). If empty, use the latest feature.

## Pre-validation

Call `speckit-validate` with `command`: `"impl"` to verify spec, plan, and tasks exist.

If validation fails, tell the user which artifacts are missing and stop.

## Task

1. Load the `speckit-converger` skill to guide your convergence check

2. Read the specification: `specs/<NNN>-<slug>/spec.md`
   - Extract all acceptance criteria (Given/When/Then)
   - Extract all edge cases
   - Extract all user stories with priorities

3. Read the implementation evidence: `specs/<NNN>-<slug>/evidence.json`
   - Check which tasks have test evidence
   - Check test exit codes

4. Read the task list: `specs/<NNN>-<slug>/tasks.md`
   - Check which tasks are marked complete
   - Check for incomplete tasks

5. **Run the test suite** to verify current state:
   - Execute the project's test command
   - Record exit code and output

6. **Convergence check** — for each acceptance criterion in the spec:
   - Is there a corresponding test? (PASS/FAIL)
   - Does the test pass? (PASS/FAIL)
   - Is the implementation complete? (PASS/FAIL)

7. **Report convergence status:**

   If ALL criteria pass:
   ```
   CONVERGED: All N acceptance criteria verified.
   - Tests: X passed, Y failed
   - Evidence: Z tasks with recorded evidence
   - Edge cases: W checked
   ```

   If ANY criterion fails:
   ```
   NOT CONVERGED: M of N criteria not met.
   Gaps:
   - [criterion 1]: missing test / test failing / not implemented
   - [criterion 2]: ...
   Suggested fixes:
   - Fix X in file Y
   - Add test for Z
   ```

8. **Update spec.json**: Set `converged` to true/false and append to `convergenceHistory`.

## Rules

- Do NOT modify implementation code — only report
- Run tests but do not fix failures (suggest fixes instead)
- Be specific about gaps — name the criterion, the file, and the line
- If all tests pass and all criteria are met, declare "CONVERGED"
- If not converged, provide actionable suggestions for each gap
- The user can run `/impl` again to fix issues, then `/converge` to re-check