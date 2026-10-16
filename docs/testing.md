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

### Behavior through the public API

| Module | Matrix file | What it varies |
|--------|-------------|----------------|
| `shared/snapshot` | `integration/matrix-snapshot.test.ts` | Trigger slugs, timestamp format, same second collisions, pin labels, drill results, listing status, and retention priority above the caps |

### Schema surfaces

| Module | File | What it varies |
|--------|------|----------------|
| Snapshot and guard schemas | `fuzz/fuzz-snapshot-schemas.test.ts` | Manifest, restore journal, pin, drill, and guard configuration against hostile values |

### Property and chaos coverage

`property/property-snapshot.test.ts` generates the inputs and asserts the invariants that must hold for every case, namely byte exact round trips, removal of artifacts created after the snapshot, idempotent trigger reuse, a fresh snapshot whenever the scope changes, and retention that never removes the newest or a pinned snapshot while respecting both caps.
Every property case builds its own worktree, because a shared worktree lets one case inherit the snapshots of the previous one.

`chaos/chaos-snapshots.test.ts` injects the failures that a real filesystem produces, namely running out of space while copying, denied permissions while creating the folder, a copy that does not match the manifest hash, a read failure during a drill, an apply that fails once, and a rollback that fails as well.
The suite asserts the transactional promises of the engine, where a failed creation leaves no folder behind, a failed drill records the error in its sidecar, a failed apply rolls back and clears the journal, and a failed rollback keeps the journal so the next attempt can recover.

## Verification helpers

`tools/test/helpers/assertions.ts` centralizes disk verification so that tests assert real data instead of reimplementing path juggling in every file.

| Helper | Purpose |
|--------|---------|
| `writeProjectFile`, `readProjectFile`, `readProjectJson` | Handle project relative paths with either separator style and tolerate a byte order mark |
| `expectFileExists`, `expectPathMissing`, `expectFileContent` | Assert presence, absence, and exact bytes |
| `expectSchemaValid` | Validate any object against a Zod schema |
| `expectSessionState`, `expectFeatureSpecJson` | Read the real state files and match the expected fields |
| `listSnapshotIds`, `listSnapshotTriggers`, `snapshotDir` | Expose snapshot facts and the folder that chaos tests replace |
| `countBackupsFor`, `expectRestoreJournal` | Count checksum guarded backups and assert a pending restore |

New integration tests use these helpers instead of ad hoc `readFile` calls, and helper tests themselves run against a temp worktree.

## Workflow coverage

`integration/e2e-workflow-snapshots.test.ts` walks the whole SDD workflow and asserts the recovery points created at every stage.

- The lifecycle runs from specification through approval, planning, tasks, implementation, and completion, with exactly one verified snapshot per phase transition and one for the approval that unlocks work.
- A repair run that realigns a phase mismatch takes its pre fix snapshot before touching any file.
- An interrupted restore is reported by both health and status, recovered by the repair run, and leaves the journal cleared on disk.
- A restore returns the feature to an earlier milestone, removes the artifacts created later, and the workflow continues from there.
- A destructive operation refuses to change state when the recovery point cannot be created, and the validation gate keeps working.

## Platform-dependent tests

Case insensitive path matching and Windows error formatting cannot be reproduced on Linux, so those cases are skipped explicitly with the reason written next to them.

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
npx stryker run --mutate "tools/shared/snapshot.ts"
```

Survivors are killed with targeted `*-kill-survivors.test.ts` files, and the baseline is recorded in `reports/mutation-testing-analysis.md`.
Mutants that no test can kill because the branch is defensive and unreachable may carry a `// Stryker disable` annotation with the reason written beside it.