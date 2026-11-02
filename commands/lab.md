---
description: Run the isolated non-mutation test lab in a git worktree
---

Use the `speckit-lab` tool, which owns the worktree lifecycle described in `docs/lab.md`.

## Task

1. Map `$ARGUMENTS` to the tool call:
   - empty or `list` → subcommand `list`
   - `create [label] [trust=<trusted|suspicious|untrusted|hostile>] [provider=<auto|worktree|os-sandbox|container|vm>]` → subcommand `create`, with `label`, `trust` and `provider` when provided, the auto policy resolves the provider from the trust level
   - `run <category|profile> [id]` → subcommand `run`, with `category` or `profile`, and `id` when provided
   - `status [id]` → subcommand `status`
   - `diff [id]` → subcommand `diff`
   - `promote [id]` → subcommand `promote`
   - `destroy [id]` → subcommand `destroy`
   - `disable` → subcommand `disable`
   - `enable` → subcommand `enable`
2. Call `speckit-lab` with the mapped arguments.
3. Report the sandbox id, the run status, the counts and the report path. Keep the output short unless a step failed.

## Rules

- Create a sandbox before running anything; `run` uses the newest active sandbox when `id` is omitted.
- Run `diff` before `promote` and show the user the changed files. Pass `confirmed: true` only after the user explicitly confirms.
- If the checkout HEAD moved after `create`, `promote` refuses to apply the patch. Create a new sandbox from the current HEAD and review it again.
- Pass `confirmed: true` for `destroy` and `prune` only after the user explicitly confirms; reports stay under `.opencode/lab/`. A sandbox whose worktree disappeared can still be destroyed to clean the registry.
- `disable` and `enable` also need `confirmed: true`, because they flip the lab kill switch. While the switch holds, `create` and `run` are safe no-ops, `status`, `destroy` and `prune` keep working, and the policy file stays under `.opencode/lab/policy.json`. The `OPENCODE_LAB_DISABLED=1` environment variable overrides everything.
- `prune` is a dry run unless confirmed. `baseline` requires a passed run. `compare` writes JSON and Markdown reports.
- Never add or run mutation tests. The lab excludes `*-mutation.test.ts`, `*-mutation-*.test.ts`, `*-kill-survivors.test.ts` and `*-kill.test.ts`.
- `soak` and `smoke` are heavy and require confirmation. Never start them without warning the user.
- The lab needs a git repository. If the project has no git metadata, say so and stop; do not copy files by hand.
- The lab links matching dependencies or installs from the sandbox lockfile when needed; the checkout `node_modules` is never modified. If an install fails, read `dependencies.log` before retrying.
- `security` runs the safe attack corpus under `tools/test/corpus` and covers traversal, symlinks, hardlinks, TOCTOU, environment leaks, command injection, malicious patches, registry and lockfile tampering, package scripts, git hooks and resource exhaustion.
- Promotion applies a patch to the working tree and does not commit. Run the normal suite in the checkout afterwards.
