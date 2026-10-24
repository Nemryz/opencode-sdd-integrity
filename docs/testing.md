# Testing Guide

How this project tests itself, the conventions every new module must follow, and the inventory of what each layer covers.
The guide is the checklist that keeps a new tool from shipping without the coverage its risk deserves.

## Principles

Integration comes first because the system is a filesystem protocol, so anything that reads or writes state runs against a real temp worktree created under `os.tmpdir()`.
Unit tests are reserved for pure functions that have no reason to touch a disk.
Every test asserts data on disk, so a tool that reports success while writing nothing fails its own test.
The suite is pollution free, because running it may never modify the repository, and that property is verified after every sweep.
Repository owned content is separated from locally installed plugins, so content tests read their expectations through `isKitOwned()` and never trip over files that a plugin added to the config directory.

## Test types

Each type answers a different question, and the directory layout tells you which one a file belongs to.

| Type | Directory | Question it answers |
|------|-----------|---------------------|
| Unit | `tools/test/unit/` | Does this pure function compute the right value |
| Matrix | `tools/test/unit/matrix-*.test.ts` and `tools/test/integration/matrix-*.test.ts` | Does it compute the right value across many inputs |
| Integration | `tools/test/integration/` | Does the tool leave the filesystem in the right state |
| Workflow | `tools/test/integration/e2e-*.test.ts` and `tools/test/manual/` | Does a whole command sequence hold together |
| Property | `tools/test/property/` | Does an invariant hold for generated inputs |
| Chaos | `tools/test/chaos/` | Does the system survive injected filesystem failures |
| Concurrency | `tools/test/concurrency/` | Does locking prevent corruption under parallel access |
| Fuzz | `tools/test/fuzz/` | Does every schema reject hostile values without crashing |
| Snapshot | `tools/test/snapshot/` | Does a command produce exactly this output |
| Mutation | `*-mutation.test.ts` and `*-kill-survivors.test.ts` | Do the tests notice when the logic changes |
| Shipped surface | `tools/test/integration/shipped-surface.test.ts` | Does the packaging still describe the repository truthfully |
| Installer | `tools/test/install/` | Does the npm CLI install, back up, and verify the promised surface |
| Smoke | `tools/test/smoke/` | Does the real OpenCode runtime load the shipped wiring |
| Migration | `tools/test/mcp/` and `tools/test/integration/migration-*.test.ts` | Does a V1 configuration move to V2 without losing state, agents or plugin origins |

The isolated lab in `docs/lab.md` runs these categories in a disposable git worktree and adds the `quick`, `standard`, `hard` and `soak` profiles. It is a runner, not another test type, and it excludes the mutation suites so a pressure run never turns into a Stryker measurement.

## The multi-value matrix convention

A single happy path test proves almost nothing, so every pure function and every behavioral rule gets an `it.each` table that varies the values instead of repeating the scenario.
The tables encode the behavior the code actually has, and the expectation is verified against the implementation before it is written down.
When reality and the assumption disagree, the code decides which one is correct and the reason is written next to the case.

### Value families

Every table mixes these five families, because bugs live in the seams between them rather than in the middle.

| Family | Examples |
|--------|----------|
| Boundary | Empty string, single character, exact maximum length, one character past the maximum, zero, one, and the largest safe integer |
| Invalid | Null, undefined, wrong primitive type, missing required field, and negative numbers |
| Unicode | Japanese text, emoji, accented latin letters, the check mark, and the zero width and null byte characters |
| Structural | Nested objects, empty arrays, arrays holding one bad element, and traversal looking paths |
| Platform | Windows separators and casing, POSIX paths, absolute paths, and relative paths |

### Writing a table

The label carries the intent and the last column carries the truth, so a failure names the case that broke.

```ts
it.each([
  ["plain string", "value", true],
  ["empty string", "", false],      // rejected by z.string().min(1)
  ["unicode string", "日本語のみ", true],
  ["null", null, false],
])("id: %s -> %s", async (_label, value, accepted) => {
  expect(SomeSchema.safeParse({ ...base, id: value }).success).toBe(accepted)
})
```

## Matrix inventory

Matrices are grouped by the layer they exercise, because a pure function test and a public API test fail for different reasons.

### Pure functions

| Module | Matrix file | What it varies |
|--------|-------------|----------------|
| `shared/types` | `unit/matrix-types.test.ts` | Directory number parsing, phase detection across file combinations, path safety, package manager detection, and complexity monotonicity |
| `shared/io` | `unit/matrix-io.test.ts` | Byte order mark handling, body checksum equivalence under line endings and padding, backup source keys, and errno matchers |
| `plugins/speckit-guard` | `unit/matrix-guard.test.ts` | Path normalization, basename extraction, always protected files, approval gated files, phase gated files, feature directory scoping, and redirect extraction |
| `shared/state` | `unit/state-paths.test.ts`, `integration/state-plan-hardening.test.ts`, `fuzz/fuzz-state-plan.test.ts` | Traversal, absolute and Windows path rejection, scope normalization, transient path exclusions, canonical JSON and journal round trips, tree hash sensitivity, canonical plan hashes, malformed plans, operations and journals, rename overlap, precondition kinds and virtual target collisions |

### Behavior through the public API

| Module | Matrix file | What it varies |
|--------|-------------|----------------|
| `shared/snapshot` | `integration/matrix-snapshot.test.ts` | Trigger slugs, timestamp format, same second collisions, pin labels, drill results, listing status, and retention priority above the caps |
| `speckit-archive` | `integration/archive-safety.test.ts`, `integration/archive-hardening.test.ts`, `integration/archive-conflict.test.ts` | Traversal names, symlinked sources and archive directories, `EXDEV`, target collisions, two concurrent archive calls, timestamp padding, root warnings, latest selection, parent projects and two forced target races |
| `shared/state` files | `integration/state-files-hardening.test.ts`, `integration/auto-commit-language.test.ts` | Session history capping, checksum repair, config validation, post-write schema and checksum failures, caller-visible session mutation and the language-only auto commit revert |

### OpenCode 2 plugin surface

| Module | File | What it covers |
|--------|------|----------------|
| `plugins/speckit-tools` | `integration/plugin-v2-tools.test.ts` | The registration shape of the nineteen tools, the direct exposure flag, and the argument schemas |
| `plugins/speckit-guard` | `integration/plugin-v2-adapters.test.ts` | The V2 entrypoint that wires the tool and permission hooks and mirrors the server behavior |
| `plugins/speckit-perfmon` | `integration/plugin-v2-adapters.test.ts` | The V2 entrypoint that wires the execution timing hooks and writes the load marker |
| `plugins/speckit-doom-loop` | `integration/doom-loop.test.ts` | Fingerprinting, option parsing, failure classifiers and the tracker, plus the V2 hooks and the V1 server fallback that warn and then block repeated failing calls |

### Schema surfaces

| Module | File | What it varies |
|--------|------|----------------|
| Snapshot and guard schemas | `fuzz/fuzz-snapshot-schemas.test.ts` | Manifest, restore journal, pin, drill, and guard configuration against hostile values |
| State plan, operation and journal schemas | `fuzz/fuzz-state-plan.test.ts` | Missing hashes, unknown operations, wrong primitive types, hostile scopes and malformed journals |

### Property and chaos coverage

`property/property-snapshot.test.ts` generates the inputs and asserts the invariants that must hold for every case, namely byte exact round trips, removal of artifacts created after the snapshot, idempotent trigger reuse, a fresh snapshot whenever the scope changes, and retention that never removes the newest or a pinned snapshot while respecting both caps.
Every property case builds its own worktree, because a shared worktree lets one case inherit the snapshots of the previous one.

`property/property-state-plan.test.ts` generates session histories and asserts that the same plan input produces the same base, expected and plan hashes, that the simulated expected hash equals the hash after apply, and that recovery is safe to repeat.

`property/property-phase-machine.test.ts` runs the workflow as a model-based state machine, generating sequences of scaffold, approve, phase and validate commands and asserting after every command that spec.json and session.json stay schema valid, that the stored phase, the approvals and the ready flag never contradict each other, and that validate reads the state without rewriting spec.json.

`chaos/chaos-snapshots.test.ts` injects the failures that a real filesystem produces, namely running out of space while copying, denied permissions while creating the folder, a copy that does not match the manifest hash, a read failure during a drill, an apply that fails once, and a rollback that fails as well.
The suite asserts the transactional promises of the engine, where a failed creation leaves no folder behind, a failed drill records the error in its sidecar, a failed apply rolls back and clears the journal, and a failed rollback keeps the journal so the next attempt can recover.

`chaos/chaos-state.test.ts` injects a failed session landing, a failed checksum sidecar and a failed journal write during an archive transaction, then asserts that the feature returns to `specs/`, the original spec and session bytes come back, and no transaction directory survives.
`integration/state-apply.integration.test.ts` covers the same protocol end to end, including a random sequence of session, spec and config writes whose on-disk hash must equal the planned expected hash, two concurrent applies of one plan where only one wins, and the recovery of an applying journal whose rename already happened.
`integration/state-recovery.integration.test.ts` also proves that a committed journal only needs cleanup, that a failed rollback stays visible instead of being silently discarded, that a foreign archive target created by a collision is left intact while the source stays in place, and that missing sources, missing or escaping backups, checksum mismatches and unreadable journals fail with the documented error.
`integration/archive-safety.test.ts` covers traversal names, symlinked sources and archive directories, `EXDEV`, a target that appears after planning and two archive calls that race for the same feature.
`integration/archive-hardening.test.ts` pins the single digit date padding, root warnings, latest numbered selection, parent project warning, collision suffixes and the archived output, while `integration/archive-conflict.test.ts` forces both apply attempts to lose the target race and asserts the stable conflict result.

## Verification helpers

`tools/test/helpers/assertions.ts` centralizes disk verification so that tests assert real data instead of reimplementing path juggling in every file.

| Helper | Purpose |
|--------|---------|
| `writeProjectFile`, `readProjectFile`, `readProjectJson` | Handle project relative paths with either separator style and tolerate a byte order mark |
| `expectFileExists`, `expectPathMissing`, `expectFileContent` | Assert presence, absence, and exact bytes |
| `expectSchemaValid` | Validate any object against a Zod schema |
| `expectSessionState`, `expectFeatureSpecJson` | Read the real state files and match the expected fields |
| `listSnapshotIds`, `listSnapshotTriggers`, `snapshotDir` | Expose snapshot facts and the folder that chaos tests replace |
| `snapshotFilePath`, `tamperSnapshotFile` | Reach a stored copy and make its checksum stop matching the manifest |
| `writePendingRestoreJournal`, `expectRestoreJournal` | Plant and assert the journal that marks an interrupted restore |
| `countBackupsFor` | Count the checksum guarded backups of one file |

New integration tests use these helpers instead of ad hoc `readFile` calls, and helper tests themselves run against a temp worktree.
The six snapshot suites (`snapshot.test.ts`, `snapshot-restore.test.ts`, `snapshot-prune.test.ts`, `snapshot-drill.test.ts`, `snapshot-tool.test.ts`, and `matrix-snapshot.test.ts`) were retrofitted onto this set, so a fixture change lands in one place instead of six.
`tamperSnapshotFile` exists because corrupting a stored copy is the precondition of the verify, drill, and restore tests, and spelling it out keeps those tests from rebuilding the snapshot layout.

## Workflow coverage

`integration/e2e-workflow-snapshots.test.ts` walks the whole SDD workflow and asserts the recovery points created at every stage.

- The lifecycle runs from specification through approval, planning, tasks, implementation, and completion, with exactly one verified snapshot per phase transition and one for the approval that unlocks work.
- A repair run that realigns a phase mismatch takes its pre fix snapshot before touching any file.
- An interrupted restore is reported by both health and status, recovered by the repair run, and leaves the journal cleared on disk.
- A restore returns the feature to an earlier milestone, removes the artifacts created later, and the workflow continues from there.
- A destructive operation refuses to change state when the recovery point cannot be created, and the validation gate keeps working.

## Smoke coverage

`tools/test/smoke/v2-smoke.sh` grades the wiring inside the real runtime, because plugin discovery, tool exposure, and the guard hooks only exist there.
It installs the kit into an isolated config home through the npm CLI with the dependency switch, boots OpenCode 2 with `--standalone`, and grades the plugin markers, the tool registry, and the guard denial.
`tools/test/smoke/smoke-probe.ts` is copied in as an extra plugin, and it records `ctx.tool.list()` right after the setups run, which turns the direct exposure rule into an assertion that needs no model.
The model evidence is graded as a warning unless `SMOKE_LLM_REQUIRED=1` is set, because the free model tier can be unavailable while the wiring itself is healthy.
`.github/workflows/smoke.yml` runs the script on every push against a pinned CLI version.

## Install coverage

`install.sh` and `install.ps1` take a git ref, a target directory, and a dependency switch, and they keep the previous copy of every file they replace in a timestamped `.install-backups` folder.
`.github/workflows/install.yml` installs the branch that triggered the run once, edits the installation like a user would, installs again, and grades both passes.
`tools/test/install/verify-install.sh` and `tools/test/install/verify-install.ps1` check the file surface the installer must leave behind, and in backup mode they also assert that exactly one timestamped folder holds the edited file, that the fresh copy replaced the same file in place, and that the configuration kept the user edit.
`tools/install/cli.mjs` is the npm entry point, so the same install runs without git: it resolves the configuration directory from `--dir`, `XDG_CONFIG_HOME`, or the home fallback, refuses the filesystem root, the home directory and the package directory, backs up exactly the files it replaces in one timestamped folder, bootstraps `opencode.jsonc` only when it is missing, and installs the runtime dependencies with `--omit=dev` unless `--skip-deps` is passed.
The npm tarball carries the root lock as `npm-shrinkwrap.json`, because `npm pack` keeps that file while it strips `package-lock.json`. The surface ships it as a required verify path, and the dependency install resolves from that lock instead of building a fresh peer set, which is what R-16 in `docs/regressions.md` records.
`tools/install/surface.json` is the single source of truth for the copy sets and the verify paths, and `tools/test/install/installer.test.ts` fails when the two install scripts, the two verify scripts and the surface file stop agreeing.
The `npm-linux` and `npm-windows` jobs install through the CLI, and the Linux job also installs a tarball produced by `npm pack`, runs the CLI straight from the extracted package with the dependency install enabled, and grades the result.
The shell and PowerShell jobs pass the dependency switch, because the npm job already proves that the dependency tree resolves inside an isolated configuration directory.

## V1 to V2 migration coverage

The migration suite is test only and never changes production code.
It proves that a real V1 configuration moves to V2 without losing the user configuration, the local state or the agent wiring.
The real migration path is a `git switch` from V1 to V2 with the smudge filter, not a fresh installer run.

| Layer | File | What it proves |
|-------|------|----------------|
| T0 | `tools/test/mcp/mcp-config.test.ts` | The fixture and the metadata matrix agree on eighteen servers, eleven disabled tool families with wildcard patterns, three agent scopes, nineteen tools and five shims |
| T1 | `tools/test/integration/migration-v1-v2.test.ts` | `opencode.jsonc` stays byte identical, local state survives, `AGENTS.md` keeps its backup and the guard migrates to version 2 only after a denied edit |
| T1b | `tools/test/integration/migration-filter.test.ts` | The real Engram 1.15.1 filters strip repeated blocks, restore one block, preserve CRLF and keep orphan V1 and V2 branches clean |
| T1c | `tools/test/smoke/opencode1-config.test.ts` | OpenCode 1 reports the five `./plugins/speckit-*` origins and no `./tools/plugins/speckit-*` origin |
| T2 | `tools/test/mcp/mcp-live.test.ts` | A sanitized live configuration carries all eighteen server keys, probes each enabled server and compares the sorted tool list |

```bash
npx vitest run \
  tools/test/mcp/mcp-config.test.ts \
  tools/test/integration/migration-v1-v2.test.ts \
  tools/test/integration/migration-filter.test.ts \
  tools/test/smoke/opencode1-config.test.ts
```

`tools/test/mcp/mcp-matrix.json` stores metadata only, namely the name, transport, timeout, enabled state, agent visibility and required environment names.
The repository fixture uses placeholders and never carries a real command, URL, path or secret.
The live block lives outside the repository and T2 reads it through `MCP_CONFIG`, because `opencode debug config` redacts the API keys.
T2 is skipped unless `MCP_LIVE=1`, so the default suite and CI never contact a live MCP server.
T2 requires all eighteen server keys, probes only the servers enabled in the live configuration, treats `firecrawl` as presence only and compares the sorted tool list against the baseline.
It resolves `{env:VAR}` values and skips only `MCP_SKIP` entries, missing environment variables and a closed Anki instance, while a missing command fails the probe.
It kills the child process tree after every probe.
`tools/test/mcp/mcp-probe.test.ts` covers the baseline path, the outside repository guard, environment resolution and the baseline round trip without contacting a server.
The per server probe timeout is the configured timeout plus five seconds, with `context7` and `anki` using sixty seconds, and the test timeout is 335 seconds.
Preinstall the npx packages before a cold run, because the first npx invocation can take longer than the per server timeout.

```bash
MCP_LIVE=1 MCP_CONFIG=/absolute/path/outside/the/repository/mcp-live.json \
  npx vitest run tools/test/mcp/mcp-live.test.ts
MCP_LIVE=1 MCP_CONFIG=/absolute/path/outside/the/repository/mcp-live.json MCP_BASELINE_MODE=write \
  npx vitest run tools/test/mcp/mcp-live.test.ts
```

The first run with `MCP_BASELINE_MODE=write` creates `~/.opencode/mcp-baseline.json` by default, and `MCP_BASELINE_PATH` can point somewhere else outside the repository.
Later runs compare the server name and the sorted tool list and allow a version drift.
T1c runs in the `v1-coverage` job against OpenCode 1.19.3 and skips clearly on every other runtime.
The job installs the repository test dependencies before the check and the runtime dependencies inside the isolated installation.

## Platform-dependent tests

Case insensitive path matching and Windows error formatting cannot be reproduced on Linux, so those cases are skipped explicitly with the reason written next to them.
CI runs the test matrix on Linux and Windows, while macOS-specific assertions remain in `types.test.ts` and run only on a macOS machine, so a macOS regression is not caught by CI.

- `guard-safety.test.ts` skips case insensitive matching on Linux.
- `b6-sweep.test.ts` skips kit directory detection with different casing on Linux.
- `config-kill-survivors.test.ts` skips the Windows warning separator outside Windows.

A bare `it.skip` is never acceptable, because an unexplained skip hides a regression that a future platform may expose.

## Language lint

```bash
npm run lint:lang
```

The lint walks every tracked source file and fails when Cyrillic, Greek, kana, CJK ideographs, Hangul, or fullwidth forms appear outside string literals.
Unicode literals inside fixtures are allowed because they are the subject under test, and the fuzz directory is excluded because it embeds hostile values on purpose.
Repository hygiene checks skip themselves when git metadata is missing, because the released archive carries no repository history.

## Stability rules

Flakes hide in ordering and timing, so these rules exist because they were learned by being broken.

### Windows specifics

Transient rename failures with `EPERM`, `EBUSY`, or `EACCES` are retried instead of failing the run.
Teardown tolerates `ENOTEMPTY`, `EBUSY`, and `EPERM` through `removeDirWithRetry`.
Filesystem assertions that rely on case folding carry a platform skip so they cannot pass silently on Linux.

### Ordering and timing

Parallel filesystem mutations are flaky by nature, so sequential writes are preferred and parallel contention tests use `Promise.allSettled` with tolerant assertions.
Global state such as `corruptionWarnings` is cleared between tests.
A stable suite is confirmed by running it more than once and by running it without file parallelism, which exposes hidden order dependence.

## Adding a new tool or feature

Pure logic earns a unit test and a matrix row in the matching `matrix-*.test.ts` file.
State changes earn an integration test in a temp worktree that asserts the files on disk.
A new Zod schema earns fuzz cases in `tools/test/fuzz/`.
A new command earns an entry in the `KIT_COMMANDS` list of `shipped-surface.test.ts`.
A new risk area earns property, chaos, or concurrency coverage, whichever failure mode it carries.
A new module earns a row in the inventory above, because an undocumented matrix is a matrix nobody maintains.

## Mutation testing

Stryker runs on demand through `.github/workflows/stryker.yml` and per module locally.

```bash
npx stryker run --mutate "tools/shared/snapshot/manifest.ts"
```

The snapshot engine lives in `tools/shared/snapshot/`, so a single module is measured on its own instead of through the former monolith.
The baseline is recorded in `reports/mutation-testing-analysis.md`.
Mutants that no test can kill because the branch is defensive and unreachable may carry a `// Stryker disable` annotation with the reason written beside it.

### How the score is calculated and what ignoreStatic does to it

Stryker computes the score as `(killed + timedOut) / (killed + timedOut + survived + noCoverage)`, which leaves mutants that fail to compile or fail at runtime out of the denominator, because no test can ever kill them.
Never recompute this score as `killed / totalMutants`, because that divides by a different set and yields a number that looks worse without any change in the code.

`ignoreStatic` is enabled in `stryker.conf.json` because static mutants are the slowest kind, since each one runs the whole suite against the batch.
On the `snapshot-paths` batch it saved 10,6 minutes down to 9,1 minutes, which is 14% rather than the dramatic saving a small file suggests, because `tools/speckit-complexity.ts` took 11m22s with static mutants against 3m03s without them while none of its ten could be killed.

The cost is larger than a comparability caveat, because the static mutants of this kit are not all untestable.
On the same batch 13 of the 19 static mutants are killed by existing tests, and ignoring them moves those 13 into the ignored state instead of the killed one, so the score falls from 70,33% to 68,86% while the tests keep doing exactly the work they were doing.
That trade is accepted on purpose, trading a signal the suite already covers for a faster batch, and the numbers are recorded here so nobody rediscovers them by measuring a sample file and concluding the opposite.

Every recorded score therefore states that static mutants were ignored, because a score read without them is lower than it would be with them, and a breaking threshold set on that variant would be measuring less rather than testing more.
The lesson worth keeping is that a conclusion about mutation behaviour drawn from one small file does not generalize, and the batch that produces the numbers anyone acts on is the one worth measuring before deciding.

### The score depends on where the aggregation is cut

A score is never a property of a file alone, because it is a ratio and the denominator is a choice.
`tools/shared/snapshot/triggers.ts` measures 52,05% on its own, and the `snapshot-paths` batch that holds that file together with `tools/shared/snapshot/paths.ts` measures 70,33%, because `paths.ts` is covered well enough to lift the average.
A file that looks weak inside its batch can be fine on its own, and the reverse is equally true, so two scores are only comparable when they were cut at the same place.

Every reported number therefore names what it covers, and a batch score is never restated as a file score without saying so.
The per batch figures live in `reports/mutation-testing-analysis.md`, and the batch list comes from `mutation-batches.json` rather than from a hand written list, so the boundary of each figure is auditable.

### Batches are the source of truth

`mutation-batches.json` owns which files are measured and in which group, and `stryker.conf.json` is kept in sync with it.
The `speckit-mutation` tool drives the whole thing with `list`, `run <batch...>` and `aggregate`, and the `/matrix` and `/baseline` commands wrap those subcommands for the common cases.
`/matrix` measures the batches one after another, never in parallel, because every Stryker run starts the whole suite in its dry run and running several at once only makes each one slower, while `/baseline` adds the stored reports up and names the batches that are still pending.
That rule is about one machine: the workflow hands each batch to its own runner and runs up to five at once, because there the dry runs no longer compete for the same cores.

Measuring all forty eight files in one job takes longer than any CI runner should hold a slot, so the file splits them into sixteen batches that each hold one domain and stay under roughly twelve hundred lines.
The workflow never repeats a batch id, because a `batches` job reads the file, checks that every path exists, and emits the matrix that the `mutate` job consumes.
Adding a file means adding it to one batch, and `mutation-batches.test.ts` fails when a path lands in two batches, when the union stops matching `stryker.conf.json`, or when a batch grows past the size a CI job can finish.

```bash
npx stryker run --mutate "$(jq -r '.batches[] | select(.id == "snapshot-retention") | .mutate | join(",")' mutation-batches.json)"
```

The same filters run inside CI, so a batch measured locally and a batch measured in the matrix mutate exactly the same files.
Neither `mutation-batches.json` nor `stryker.conf.json` is published or copied by the install scripts, because measuring the kit belongs to a checkout of the kit and not to an installed copy, which is why `/matrix` and `/baseline` report a clear message when they run outside one.
The installer CLI stays outside the batches, because the current Stryker setup mutates TypeScript modules through the type checker while `tools/install/` is plain ESM without a build step, so its behavior is pinned by the installer integration suite instead.

### Current baseline

The full matrix was last measured on 2026-10-23 against `1943c8c`: sixteen batches, 8780 mutants (5895 valid), 4221 killed, 1178 survived and 482 without coverage, for a combined score of 71,84% after about 71 minutes in Actions.
Three batches sit in the high band (`plugin-events` 92,86%, `tools-config-guard` 83,33%, `snapshot-restore` 82,35%), and `plugin-shims` reports 0,00% because its two valid mutants have no coverage.
The lowest meaningful batches are `tools-archive` 55,94% and `shared-state-files` 57,06%, both split for this release, and their survivors are recorded as follow-up work instead of hidden in the aggregate.
The per batch figures and the survivor decisions are in `reports/mutation-testing-analysis.md`.

### One place computes the score

`.github/scripts/report-score.mjs` is the only place in the repository that turns a report into a percentage, because it calls `mutation-testing-metrics`, the same package Stryker uses.
The `mutate` job runs it so each batch prints its own score in the run page, the tool's `aggregate` subcommand runs it again over every stored report to add them up, and both take the number from that one implementation.
A test fails if the tool ever grows a division of its own, since two implementations of the same ratio is how a score starts telling two different stories about the same code.

### Directed suites and what their names mean

These files are ordinary vitest suites that pin behavior on purpose, and they are named so the reason they exist survives the sprint that wrote them.

| Suffix | What the file is | What it is not |
|--------|-------------------|----------------|
| `*-mutation.test.ts` | A suite written for one module, where every case kills a specific mutation class such as a flipped condition, a swapped boundary, or a dropped branch | Not a Stryker run and not a copy of the whole test suite |
| `*-kill-survivors.test.ts` | A suite that closes the mutants a previous run reported as escaped, usually named after the tool it protects | Not a performance suite and not a place for unrelated coverage |

The rule behind both names is that a mutant only dies when a test fails without the mutation, so each case must assert an observable fact on disk or on the returned result rather than restate the implementation.
A directed suite that cannot kill the mutant it was written for is dead weight and belongs in the report as a decision instead of in the suite as a hope.
Both suffixes run in the normal suite and in CI, because a survivor killer that only passes under Stryker would hide the regression it exists to catch.