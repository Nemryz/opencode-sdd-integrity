---
description: Run the isolated non-mutation test lab in a git worktree
---

Use the `speckit-lab` tool, which owns the worktree lifecycle described in `docs/lab.md`.

## Task

1. Map `$ARGUMENTS` to the tool call:
   - empty or `list` → subcommand `list`
   - `create [label]` → subcommand `create`, with `label` when provided
   - `run <category|profile> [id]` → subcommand `run`, with `category` or `profile`, and `id` when provided
   - `status [id]` → subcommand `status`
   - `diff [id]` → subcommand `diff`
   - `promote [id]` → subcommand `promote`
   - `destroy [id]` → subcommand `destroy`
2. Call `speckit-lab` with the mapped arguments.
3. Report the sandbox id, the run status, the counts and the report path. Keep the output short unless a step failed.

## Rules

- Create a sandbox before running anything; `run` uses the newest active sandbox when `id` is omitted.
- Run `diff` before `promote` and show the user the changed files. Pass `confirmed: true` only after the user explicitly confirms.
- If the checkout HEAD moved after `create`, `promote` refuses to apply the patch. Create a new sandbox from the current HEAD and review it again.
- Pass `confirmed: true` for `destroy` only after the user explicitly confirms; reports stay under `reports/lab`. A sandbox whose worktree disappeared can still be destroyed to clean the registry.
- Never add or run mutation tests. The lab excludes `*-mutation.test.ts`, `*-mutation-*.test.ts`, `*-kill-survivors.test.ts` and `*-kill.test.ts`.
- `soak` and `smoke` are heavy and require confirmation. Never start them without warning the user.
- The lab needs a git repository. If the project has no git metadata, say so and stop; do not copy files by hand.
- The lab links matching dependencies or installs from the sandbox lockfile when needed; the checkout `node_modules` is never modified. If an install fails, read `dependencies.log` before retrying.
- Promotion applies a patch to the working tree and does not commit. Run the normal suite in the checkout afterwards.
