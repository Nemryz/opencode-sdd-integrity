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
| `create` | Creates a detached worktree under the system temp directory and links `node_modules` |
| `run` | Runs a category or profile in the newest active sandbox |
| `status` | Shows the sandbox, its dirty files and its latest run |
| `diff` | Stages the sandbox, writes a patch under `reports/lab` and shows the stat |
| `promote` | Applies the patch to the checkout after explicit confirmation; never commits |
| `destroy` | Removes the worktree after explicit confirmation; reports and patches stay |
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
- `node_modules` is linked from the checkout instead of copied. If the link fails, the sandbox records a warning and the user can install inside it.
- The run uses `tools/lab/vitest.config.lab.ts`, which puts the Vite cache in `.lab-cache` inside the sandbox and coverage under the run report directory.

The sandbox does not copy ignored files other than the dependency link. If a test needs an ignored local file, copy it into the sandbox manually; the lab does not guess which ignored files are safe.

## Promotion

`diff` stages only project files, excluding `node_modules`, `.lab-cache`, `coverage` and `reports`, and writes a binary-safe patch. `promote` checks the patch with `git apply --check --3way`, applies it to the checkout, and leaves the result uncommitted. A conflict leaves the checkout unchanged and keeps the patch for inspection.

A sandbox becomes `promoted` and cannot be promoted twice. Destroy it and create a new sandbox for another change. `destroy` removes the worktree; the reports, patches and summary stay in `reports/lab`, which is gitignored.

## Reports

Each run writes:

```text
reports/lab/
  registry.json
  <sandbox-id>/
    diffs/diff-<id>.patch
    runs/<run-id>/
      summary.json
      step-1.log
      unit.json
      coverage/coverage-summary.json
```

`summary.json` carries the selection, exit status, step results, test totals, coverage totals and the slowest tests. The tool prints the path, so a later session can read the evidence without rerunning the suite.

## The generic node adapter

When the project is not the integrity kit but has a `package.json`, the lab uses the node adapter. It maps `test`, `typecheck`, `lint` or `lint:lang` and `test:coverage` scripts to categories, and runs `quick`, `standard` or `hard` profiles with the scripts that exist. It detects npm, pnpm, yarn and bun from the lockfile.

The adapter contract lives in `tools/lab/core/types.ts`: a category list, a profile list, an exclusion list and a `plan` function that returns commands. A new adapter belongs in `tools/lab/adapters/` and is selected in `tools/lab/adapters/index.ts`.

## Limits

- The worktree separates the run from the checkout; it is not a security sandbox. Only run code you trust.
- The MVP requires git. A project without git metadata gets a clear error instead of a copy mode.
- The lab does not install dependencies automatically. Link `node_modules` from the checkout or install inside the sandbox.
- The smoke category depends on the local OpenCode installation and runs only on POSIX.
- The lab does not replace the normal suite, the install workflow or the mutation workflow. It gives those layers a disposable place to run under pressure.
