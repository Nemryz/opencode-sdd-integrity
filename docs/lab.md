# Isolated Test Lab

The test lab runs the repository's non-mutation tests in a disposable git worktree, keeps the reports, and applies only the changes a reviewer promotes. It answers a different question than the normal suite: does the checkout survive a hard run without touching the author's working tree?

The lab is part of the kit, not of the OpenCode core. It uses `git worktree` through a small provider interface today, so it works on OpenCode 1 and OpenCode 2 without a runtime-specific API.

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
| `create` | Creates a detached worktree under the system temp directory and prepares dependencies from the lockfile |
| `run` | Runs a category or profile in the newest active sandbox |
| `status` | Shows the sandbox, its dirty files and its latest run |
| `diff` | Stages the sandbox, writes a patch under `reports/lab` and shows the stat |
| `promote` | Applies the patch after explicit confirmation and only if HEAD still matches `baseCommit`; never commits |
| `destroy` | Removes the worktree after explicit confirmation; reports and patches stay |
| `prune` | Dry-runs or removes stale sandboxes, old reports and orphan worktrees |
| `baseline` | Stores the latest successful run as the baseline for its category or profile |
| `compare` | Compares the latest run against the stored baseline and writes JSON and Markdown reports |
| `list` | Lists the sandboxes known to this project |
| `help` | Prints the command and profile reference |

`create` can receive a label, and every command can receive a sandbox id. `run` uses the newest active sandbox when the id is omitted.

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

## What the sandbox contains

`create` resolves the repository root with git, creates a detached worktree from `HEAD`, and then replays the checkout's uncommitted work:

- `git diff --binary HEAD` is applied to the worktree.
- Files reported by `git ls-files --others --exclude-standard` are copied with their executable bit.
- `node_modules` is linked from the checkout only when the lockfile matches. If the sandbox lockfile differs, or the checkout has no `node_modules`, the lab installs dependencies inside the sandbox with `npm ci`, `pnpm install --frozen-lockfile`, `yarn install` or `bun install --frozen-lockfile`. The checkout dependencies are never modified.
- The dependency decision is checked again before every run, so editing a lockfile in the sandbox triggers a fresh install. The output lands in `dependencies.log` inside the run report.
- The run uses `tools/lab/vitest.config.lab.ts`, which puts the Vite cache in `.lab-cache` inside the sandbox and coverage under the run report directory.

The sandbox does not copy ignored files other than the dependency tree it prepares. If a test needs an ignored local file, copy it into the sandbox manually; the lab does not guess which ignored files are safe.

## Promotion

`diff` stages only project files, excluding `node_modules`, `.lab-cache`, `coverage` and `reports`, and writes a binary-safe patch. It also shows the sandbox base commit and the current checkout HEAD. `promote` requires a prior `diff`, so the reviewed patch hash is recorded before promotion. It also requires a clean checkout, checks the patch with `git apply --check --3way`, applies it to the checkout, and leaves the result uncommitted. A conflict leaves the checkout unchanged and keeps the patch for inspection.

Promotion is tied to the reviewed base. If the checkout HEAD moved after `create`, `promote` writes the patch and refuses to apply it, because the change would land on code the reviewer never tested. Create a new sandbox from the current HEAD and review the new diff.

A sandbox becomes `promoted` and cannot be promoted twice. Destroy it and create a new sandbox for another change. `destroy` removes the worktree; the reports, patches and summary stay in `reports/lab`, which is gitignored. A registry entry whose worktree disappeared can still be destroyed, which cleans the registry without touching the checkout.

## Reports

Each run writes:

```text
reports/lab/
  registry.json
  <sandbox-id>/
    diffs/diff-<id>.patch
    runs/<run-id>/
      summary.json
      dependencies.log
      step-1.log
      unit.json
      coverage/coverage-summary.json
```

`summary.json` carries the selection, exit status, step results, test totals, coverage totals and the slowest tests. `dependencies.log` exists when a run installed dependencies inside the sandbox. The tool prints the summary path, so a later session can read the evidence without rerunning the suite.

Registry writes take a short-lived lock at `reports/lab/registry.lock`, so two tool calls cannot silently overwrite each other's sandbox entry. The lock is released after each write and stale locks are removed after 30 seconds.

## The generic node adapter

When the project is not the integrity kit but has a `package.json`, the lab uses the node adapter. It maps `test`, `typecheck`, `lint` or `lint:lang` and `test:coverage` scripts to categories, and runs `quick`, `standard` or `hard` profiles with the scripts that exist. It detects npm, pnpm, yarn and bun from the lockfile.

The adapter contract lives in `tools/lab/core/types.ts`: a category list, a profile list, an exclusion list and a `plan` function that returns commands. A new adapter belongs in `tools/lab/adapters/` and is selected in `tools/lab/adapters/index.ts`.

## Registry pruning

`prune` is a dry run unless `confirmed: true` is passed. It marks missing worktrees as destroyed, removes destroyed entries older than the retention age, deletes their reports, and removes orphan worktrees under the lab root. Active and promoted sandboxes are never removed.

## Baselines and regression gates

`baseline` stores the latest successful run for a category or profile. `compare` measures the latest run against that baseline and writes JSON and Markdown reports under `reports/lab`. The gate fails on new failures, increased skips, dropped test counts, coverage drops larger than 0.5 points and steps that regress from passed to failed. Duration and slow tests are warnings.

## Flake detection

Failed Vitest steps can rerun only their failed files. The first rerun uses the original seed; if it passes, a second rerun uses a different seed and shuffled order. The result is classified as `real`, `order-dependent`, `flaky` or `inconclusive`. Soak runs continue after a flaky or order-dependent failure and stop after a real failure.

## Limits

- The worktree separates the run from the checkout; it is not a security sandbox. Only run code you trust.
- The MVP requires git. A project without git metadata gets a clear error instead of a copy mode.
- The lab prepares dependencies only from a supported lockfile or a matching checkout tree. If neither exists, install manually inside the sandbox.
- Dependency installation needs the package manager and access to the network or a warm cache. If it fails, the run stops before the tests and points to `dependencies.log`.
- The smoke category depends on the local OpenCode installation and runs only on POSIX.
- The lab does not replace the normal suite, the install workflow or the mutation workflow. It gives those layers a disposable place to run under pressure.
