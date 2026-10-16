# Testing Guide

How this project tests itself: test types, the multi-value matrix convention, per-module
inventory, and the rules for adding cases. This document is the checklist that keeps new
tools from shipping without the right coverage.

## Principles

1. **Integration first.** Anything that reads or writes state is tested against a real
   filesystem (a temp worktree under `os.tmpdir()`), never against mocks. Unit tests are
   reserved for pure functions.
2. **Every test verifies data on disk**, not only the text a tool returns. A tool that
   reports success while writing nothing must fail its test.
3. **No test writes outside its temp worktree.** The suite must be pollution-free: running
   it may not modify the repository. Use `createTempWorktree()` / `destroyTempWorktree()`
   from `tools/test/helpers/setup.ts`.
4. **Repo-owned content only.** Content tests enumerate `commands/`, `agents/` and `skills/`
   filtered through `isKitOwned()`, so plugins installed in the config directory never
   break the kit's own consistency checks.

## Test types and where they live

| Type | Directory | Purpose |
|------|-----------|---------|
| Unit | `tools/test/unit/` | Pure functions: parsers, path safety, matchers, checksums |
| Matrix | `tools/test/unit/matrix-*.test.ts`, `tools/test/integration/matrix-*.test.ts` | Multi-value tables (`it.each`) per pure function or behavior |
| Integration | `tools/test/integration/` | Tools end to end against a temp worktree |
| Workflow | `tools/test/integration/e2e-*.test.ts`, `tools/test/manual/` | Full command lifecycles and step-by-step flows |
| Property | `tools/test/property/` | Invariants over generated inputs (fast-check) |
| Chaos | `tools/test/chaos/` | Injected filesystem failures (ENOSPC, EACCES, ENOENT) |
| Concurrency | `tools/test/concurrency/` | Locking and parallel writes |
| Fuzz | `tools/test/fuzz/` | Hostile values against every Zod schema |
| Snapshot | `tools/test/snapshot/` | Exact CLI output of a command |
| Mutation | `*-mutation.test.ts`, `*-kill-survivors.test.ts` | Tests written to kill specific mutants (Stryker) |
| Shipped surface | `tools/test/integration/shipped-surface.test.ts` | Repo hygiene and packaging consistency |

## The multi-value matrix convention

A single `it("handles a name")` proves almost nothing. Every pure function and every
behavioral rule gets an `it.each` table that varies the **values**, not just the happy path.
Use these five value families:

| Family | Examples |
|--------|----------|
| Boundary | empty string, single char, max length, over length, `0`, `1`, max safe integer |
| Invalid | `null`, `undefined`, wrong type, missing required field, negative numbers |
| Unicode | `日本語`, emoji, `ñ`, `✓`, zero-width, null byte `\u0000` |
| Structural | nested objects, empty arrays, arrays with a bad element, traversal-looking paths |
| Platform | Windows separators and casing, POSIX paths, absolute vs relative |

Write the expectation that the code **actually** has, not the one you assume: verify
against the implementation before encoding it in the table. When reality and the
expectation differ, decide which one is correct and document the reason in a comment.

```ts
it.each([
  ["plain string", "value", true],
  ["empty string", "", false],      // rejected by z.string().min(1)
  ["unicode string", "日本語", true],
  ["null", null, false],
])("id: %s -> %s", async (_label, value, accepted) => {
  expect(SomeSchema.safeParse({ ...base, id: value }).success).toBe(accepted)
})
```

## Matrix inventory

| Module | Matrix file | What it varies |
|--------|-------------|----------------|
| `shared/types` | `unit/matrix-types.test.ts` | `parseNNN`, `detectPhase`, `detectPhaseFromFiles`, `isSafeFeatureDirName`, `detectPackageManager`, `assessComplexity` monotonicity |
| `shared/io` | `unit/matrix-io.test.ts` | `stripBom`, `computeBodyChecksum` (CRLF/whitespace equivalence), `backupSourceKey`, errno matchers |
| `plugins/speckit-guard` | `unit/matrix-guard.test.ts` | path normalization, basename, always-protected, after-approval, by-phase, feature-dir scoping, redirect extraction, constitution draft detection |
| `shared/snapshot` | `integration/matrix-snapshot.test.ts` | trigger slug, timestamp format, same-second collisions, pin/label, drill results, list status, prune priority |
| Snapshot + guard schemas | `fuzz/fuzz-snapshot-schemas.test.ts` | manifest, journal, pin, drill and guard config against hostile values |

## Platform-dependent tests

Filesystem case-insensitivity and Windows error formatting cannot be reproduced on Linux,
so those tests are skipped explicitly with a comment explaining why:

- `guard-safety.test.ts` — case-insensitive path matching (skipped on Linux)
- `b6-sweep.test.ts` — kit directory detection with different casing (skipped on Linux)
- `config-kill-survivors.test.ts` — Windows warning separator (skipped off Windows)

Never use a bare `it.skip`; always `it.skipIf(process.platform ...)` with a reason.

## Stability rules learned the hard way

- Run the suite repeatedly before trusting it: flakes hide in ordering and timing.
- `Promise.all` over filesystem mutations is flaky by nature; prefer sequential writes or
  `Promise.allSettled` with tolerant assertions.
- Retry transient rename failures (`EPERM`, `EBUSY`, `EACCES`) instead of failing the run.
- Teardown must tolerate `ENOTEMPTY`/`EBUSY`/`EPERM` on Windows (`removeDirWithRetry`).
- State modules hold global state (`corruptionWarnings`); clear them between tests.

## Adding a new tool or feature

1. Pure logic → unit test plus a matrix table in the matching `matrix-*.test.ts`.
2. State changes → integration test in a temp worktree asserting the files on disk.
3. New Zod schema → fuzz cases in `tools/test/fuzz/`.
4. New command → add its file to the `KIT_COMMANDS` list in `shipped-surface.test.ts`.
5. New risk area → property, chaos or concurrency coverage, whichever matches the failure mode.
6. Document it: if a module is new, add a row to the matrix inventory above.

## Mutation testing

Stryker runs on demand (`.github/workflows/stryker.yml`) and per module locally:

```bash
npx stryker run --mutate "tools/shared/snapshot.ts"
```

Kill survivors with targeted `*-kill-survivors.test.ts` files. Record the baseline in
`reports/mutation-testing-analysis.md`. Equivalent mutants (defensive branches that cannot
be reached) may be annotated with `// Stryker disable` **and** a comment justifying it.