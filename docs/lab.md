# Isolated Test Lab

The test lab runs the repository's non-mutation tests in a disposable git worktree, keeps the reports, and applies only the changes a reviewer promotes. It answers a different question than the normal suite: does the checkout survive a hard run without touching the author's working tree?

## Quick start

```text
/lab create
/lab run quick
/lab status
/lab diff
/lab promote
/lab destroy
```

The same flow is available through the `speckit-lab` tool:

| Subcommand | Effect |
|------------|--------|
| `create` | Creates a detached worktree under `.opencode/lab/sandboxes` and prepares dependencies from the lockfile |
| `run` | Runs a category or profile in the newest active sandbox |
| `status` | Shows the sandbox, its dirty files and its latest run |
| `diff` | Stages the sandbox, writes a patch under `.opencode/lab/patches` and shows the stat |
| `promote` | Applies the patch after explicit confirmation and only if HEAD still matches `baseCommit`; never commits |
| `destroy` | Removes the worktree after explicit confirmation; reports and patches stay |
| `prune` | Dry-runs or removes stale sandboxes, old reports and orphan worktrees |
| `baseline` | Stores the latest successful run as the baseline for its category or profile |
| `compare` | Compares the latest run against the stored baseline and writes JSON and Markdown reports |
| `list` | Lists the sandboxes known to this project |
| `help` | Prints the command and profile reference |

`create` can receive a label, and every command can receive a sandbox id. `run` uses the newest active sandbox when the id is omitted.

## Threat model

The lab assumes the code under test is untrusted but the author's checkout must stay untouched. Every sandbox action is audited, every child process runs a sanitized environment, package lifecycle scripts are disabled, hooks are neutralized, network access is blocked by default, and every path is validated before it is used. The worktree provider is process-level isolation, not kernel-enforced, so only code the reviewer trusts should run inside a sandbox.

## Path safety

All lab state lives under `.opencode/lab/` inside the project, never in the system temp directory. Every directory is created with `0700` permissions and a local `.gitignore` keeps sandboxes, reports, baselines, registry, patches and audit out of git. Path primitives reject absolute paths, traversal segments, control characters and empty candidates before any filesystem or spawn call. The `resolveInside`, `assertInsideWorkspace`, `assertRealInsideWorkspace` and `safeSegment` helpers are the single place where path safety is enforced, so checks are not scattered across the core.

## Environment sanitization

Child processes never inherit the parent environment wholesale. `safeLabEnvironment` composes the child environment from an explicit allowlist plus safe defaults, so secrets such as SSH agent sockets, cloud credentials, API keys, cookies and proxy variables never reach a sandbox command. The lab marks itself with `OPENCODE_LAB=1` and `OPENCODE_LAB_NETWORK=none`, disables Husky, npm audit/fund, Playwright/Puppeteer browser downloads and git terminal prompts, and forces colour off for deterministic output.

## Package scripts off

Dependency installation runs with lifecycle scripts disabled (`--ignore-scripts` for npm and pnpm, `--ignore-scripts` or `--immutable` for yarn and bun). A lockfile alone does not prove install scripts are safe, so the lab forces package-script mode off by default and installs from the sandbox lockfile only when needed.

## Hooks and network guardrails

Git hooks are neutralized inside every sandbox by enabling `extensions.worktreeConfig` and pointing the worktree-scoped `core.hooksPath` at an empty local directory, so the override lives in the sandbox's own `config.worktree` and the checkout keeps its original hooks untouched. Every run re-applies that setting, so a tampered sandbox run cannot reactivate hooks before the next step executes. The `OPENCODE_LAB_NETWORK=none` marker and the default `denyNetwork` control express that sandbox runs should not open network connections, and any command line that mentions `sudo`, `docker`, `firejail`, `bubblewrap` or `systemd-nspawn` is flagged as needing a no-exec adapter before it can run.

## Kill switch

The lab has one switch that holds above everything else. `OPENCODE_LAB_DISABLED=1` in the environment wins over any file, and `disable` writes `.opencode/lab/policy.json` owned by the project with `0600` permissions. While the switch holds, `create` and `run` return a `Lab Disabled` safe no-op before anything is planned, loaded or spawned, so a hostile step list in the backlog never starts. `status`, `diff`, `promote`, `destroy`, `prune`, list and compare keep working, because shutting down must not strand state on disk. `enable` clears the file after the same explicit confirmation both subcommands demand, and every policy change appends a `lab_policy` event to the audit trail.

## Cross validation

The registry is rewritten by every lab action, so every command revalidates a registry entry before it acts on it. A read refuses an id outside `A-Za-z0-9._-`, a `sandboxRoot` that does not resolve into the project's `.opencode/lab/sandboxes` tree, or a fixture whose roots are missing, and the error names the file. `promote` runs a second cross check on the loaded entry, refuses a destroyed sandbox, and compares the recorded patch hash with the patch it is about to apply, so a tampered or stale registry entry cannot instruct promotion. `destroy` rechecks the containment itself before removing the worktree, so even a registry bypass cannot point `rm` at a host path. Promotion also records `lab_promoted` with the applied patch hash and the checkout head, which closes the audit gap between writing the patch and applying it.

## Limit enforcement

Every sandbox child runs through the same runner. Output is capped at 4 MB by default and a step may set `maxOutputBytes`, so a flooding test cannot exhaust memory. Timeouts kill the whole process group, which covers grandchildren spawned by the test. A step may also request `limits` with `cpuSeconds` and `memoryBytes`; on POSIX those wrap the command in `prlimit` so the kernel enforces the ceiling, and on any system where `prlimit` is missing the lab refuses the step instead of running unbounded, so limits never downgrade silently.

## Audit trail

Every lab action appends one line to `.opencode/lab/audit/lab-audit.jsonl`: create, run, promote, destroy, prune and policy events. The audit directory and file are owned by the creating process, the file switches to read-only `0400` after each append, and the record carries the sandbox id, the isolation provider and a timestamped chronology that a later session can read to reconstruct what happened. Audit events deliberately do not log the parent environment, so secrets never reach the trail.

## Categories and profiles

The integrity adapter discovers the repository through its package name or through `mutation-batches.json` plus `vitest.config.ts`. It exposes these categories:

| Category | Path |
|----------|------|
| `all` | The whole non-mutation suite |
| `unit` | `tools/test/unit` |
| `integration` | `tools/test/integration` |
| `property` | `tools/test/property` |
| `chaos` | `tools/test/chaos` |
| `concurrency` | `tools/test/concurrency` |
| `fuzz` | `tools/test/fuzz` |
| `snapshot` | `tools/test/snapshot` |
| `install` | `tools/test/install` |
| `manual` | `tools/test/manual` |
| `security` | `tools/test/corpus` |
| `smoke` | The real OpenCode 2 CLI smoke script; POSIX only and confirmation gated |

Profiles combine steps:

| Profile | Steps |
|---------|-------|
| `quick` | Unit tests |
| `standard` | Every non-mutation test, typecheck and language lint |
| `hard` | Full suite with coverage, shuffled order with a fixed seed, typecheck and lint |
| `soak` | Three shuffled full runs plus the static gates; heavy and confirmation gated |

The mutation suites stay out of every category and profile. The exact exclusions are:

- `**/*-mutation.test.ts`
- `**/*-mutation-*.test.ts`
- `**/*-kill-survivors.test.ts`
- `**/*-kill.test.ts`

The lab never starts Stryker, never reads a mutation score and never writes to `mutation-batches.json` or the Stryker configuration. The mutation workflow remains `/matrix` and `/baseline`.

## The attack corpus

The `security` category runs the corpus under `tools/test/corpus`, a collection of hostile fixtures the lab's own tests attack with. Traversal candidates, symlinks aimed outside the workspace, hardlink survival, a swapped symlink between two checks, environment leaks, shell metacharacters in argv, a patch with traversal targets, a rewritten registry, a rewritten lockfile, a lifecycle script payload, re-enabled hooks and flooding or runaway children each meet the exact guard that must refuse them. The corpus documents the live permissions without ever pointing at the host, so a regression in the security layer becomes a failing test with the attack that proves it.

## What the sandbox contains

`create` resolves the repository root with git, creates a detached worktree from `HEAD`, and then replays the checkout's uncommitted work:

- `git diff --binary HEAD` is applied to the worktree.
- Files reported by `git ls-files --others --exclude-standard` are copied with their executable bit, excluding the lab's own `.opencode/` state so it never lands in the sandbox.
- `node_modules` is linked from the checkout only when the lockfile matches. If the sandbox lockfile differs, or the checkout has no `node_modules`, the lab installs dependencies inside the sandbox with `npm ci`, `pnpm install --frozen-lockfile`, `yarn install` or `bun install --frozen-lockfile`. The checkout dependencies are never modified.
- The dependency decision is checked again before every run, so editing a lockfile in the sandbox triggers a fresh install. The output lands in `dependencies.log` inside the run report.
- The run uses `tools/lab/vitest.config.lab.ts`, which puts the Vite cache in `.lab-cache` inside the sandbox and coverage under the run report directory.

The sandbox does not copy ignored files other than the dependency tree it prepares. If a test needs an ignored local file, copy it into the sandbox manually; the lab does not guess which ignored files are safe.

A lockfile that someone rewrote after the sandbox was created is a tamper signal, not an update. The dependency decision compares the sandbox lockfile against the hash recorded at create time, and when the sandbox lockfile moved while no install inside the sandbox proves the change, the lab refuses with a clear error and leaves the checkout untouched.

## Promotion

`diff` stages only project files, excluding `node_modules`, `.lab-cache`, `coverage`, `reports` and `.opencode`, and writes a binary-safe patch under `.opencode/lab/patches`. It also shows the sandbox base commit and the current checkout HEAD. `promote` requires a prior `diff`, so the reviewed patch hash is recorded before promotion. It also requires a clean checkout, checks the patch with `git apply --check --3way`, applies it to the checkout, and leaves the result uncommitted. A conflict leaves the checkout unchanged and keeps the patch for inspection.

Promotion is tied to the reviewed base. If the checkout HEAD moved after `create`, `promote` writes the patch and refuses to apply it, because the change would land on code the reviewer never tested. Create a new sandbox from the current HEAD and review the new diff.

A sandbox becomes `promoted` and cannot be promoted twice. Destroy it and create a new sandbox for another change. `destroy` removes the worktree; the reports, patches and summary stay in `.opencode/lab/`, which is gitignored. A registry entry whose worktree disappeared can still be destroyed, which cleans the registry without touching the checkout.

## Reports

Each run writes:

```text
.opencode/lab/
  registry.json
  registry.lock
  <sandbox-id>/
    diffs/diff-<id>.patch
    runs/<run-id>/
      summary.json
      dependencies.log
      step-1.log
      unit.json
      coverage/coverage-summary.json
  audit/lab-audit.jsonl
```

`summary.json` carries the selection, exit status, step results, test totals, coverage totals and the slowest tests. `dependencies.log` exists when a run installed dependencies inside the sandbox. The tool prints the summary path, so a later session can read the evidence without rerunning the suite.

Registry writes take a short-lived lock at `.opencode/lab/registry.lock`, so two tool calls cannot silently overwrite each other's sandbox entry. The lock is released after each write and stale locks are removed after 30 seconds.

## The generic node adapter

When the project is not the integrity kit but has a `package.json`, the lab uses the node adapter. It maps `test`, `typecheck`, `lint` or `lint:lang` and `test:coverage` scripts to categories, and runs `quick`, `standard` or `hard` profiles with the scripts that exist. It detects npm, pnpm, yarn and bun from the lockfile.

The adapter contract lives in `tools/lab/core/types.ts`: a category list, a profile list, an exclusion list and a `plan` function that returns commands. A new adapter belongs in `tools/lab/adapters/` and is selected in `tools/lab/adapters/index.ts`.

## Registry pruning

`prune` is a dry run unless `confirmed: true` is passed. It marks missing worktrees as destroyed, removes destroyed entries older than the retention age, deletes their reports, and removes orphan worktrees under the lab root. Active and promoted sandboxes are never removed. Prune also appends a `lab_pruned` audit event with the removed, marked destroyed and orphan worktree ids.

## Baselines and regression gates

`baseline` stores the latest successful run for a category or profile. `compare` measures the latest run against that baseline and writes JSON and Markdown reports under `.opencode/lab/reports`. The gate fails on new failures, increased skips, dropped test counts, coverage drops larger than 0.5 points and steps that regress from passed to failed. Duration and slow tests are warnings.

## Flake detection

Failed Vitest steps can rerun only their failed files. The first rerun uses the original seed; if it passes, a second rerun uses a different seed and shuffled order. The result is classified as `real`, `order-dependent`, `flaky` or `inconclusive`. Soak runs continue after a flaky or order-dependent failure and stop after a real failure.

## Limits

- The worktree separates the run from the checkout; it is not a security sandbox. Only run code you trust.
- The MVP requires git. A project without git metadata gets a clear error instead of a copy mode.
- The lab prepares dependencies only from a supported lockfile or a matching checkout tree. If neither exists, install manually inside the sandbox.
- Dependency installation needs the package manager and access to the network or a warm cache. If it fails, the run stops before the tests and points to `dependencies.log`.
- The smoke category depends on the local OpenCode installation and runs only on POSIX.
- The lab does not replace the normal suite, the install workflow or the mutation workflow. It gives those layers a disposable place to run under pressure.
