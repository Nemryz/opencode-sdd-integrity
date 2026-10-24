# Regression History

Historical record of significant regressions in the kit, their root causes, and the tests that guard them.
Read this before modifying `tools/shared/` or cross-tool behavior.

For prescriptive test-writing guidance, see the Test Patterns section of AGENTS.md.

---

### R-1: TEMPLATES_DIR using os.homedir() instead of module-relative path

**Introduced in:** `5cd31f2` (scaffold robustness fix)
**Fixed in:** `797f1af`

The template directory was resolved as `os.homedir() + "/.config/opencode/templates"`, which only works when the kit is cloned at `~/.config/opencode/`. On CI, other dev machines, or any clone outside the config directory, `readTemplate()` would always return `null`.

**Root cause:** The original code used a relative path (`path.resolve(__dirname, "..", "templates")`) which was incorrectly replaced with an absolute os.homedir() path.

**Fix:** Resolve relative to `import.meta.dirname` first, with os.homedir() as fallback.

**Test coverage:** `scaffold.test.ts` verifies real template content (Article I, Article II) loads from the correct path.

### R-2: isValidProjectRoot deadlock — constitution cannot bootstrap a new project

**Introduced in:** `060e469` (scaffold race condition fix)
**Fixed in:** current

`isValidProjectRoot` requires `.opencode/spec-memory/` to exist, but the only code path that creates that directory is constitution scaffolding — which also calls `isValidProjectRoot` and rejects the operation on a fresh directory.

**Root cause:** The project root validation was changed from a blacklist ("deny if inside ~/.config/opencode") to a whitelist ("must have .opencode/spec-memory/"), without exempting the bootstrap command.

**Fix:** Exempt `template: "constitution"` from the `isValidProjectRoot` check in `speckit-scaffold.ts`.

**Test coverage:** `cold-start.test.ts` (11 tests) verifies the full bootstrap sequence from an empty directory with no pre-created spec-memory.

### R-3: Test helpers must not hide production preconditions

**First identified in:** R-2 investigation

The `createTempWorktree()` helper in `tools/test/helpers/setup.ts` pre-creates `.opencode/spec-memory/`, which means no test exercises the real cold-start path. This hid the R-2 deadlock through 493 tests.

**Prevention guideline:** When adding a new test helper, verify it does not silently satisfy a precondition that production code must satisfy on its own. Add at least one test that starts from a truly empty directory without the helper.

### R-4: Approval auto-fix substring collision — message.includes instead of explicit artifact field

**Introduced in:** `babb4ac` (audit auto-fix extension to ready-violation and approval categories)
**Fixed in:** `4101e4d`

The approval auto-fix loop used `finding.message.includes("spec"/"plan"/"tasks")` to decide which approval field to flip. Since `finding.message` includes the feature directory name (e.g., `"001-tasks-view: spec.md exists but spec approval not marked generated"`), a feature named "tasks view" would cause `includes("tasks")` to match on **all** approval findings for that feature, not just the tasks one.

**Root cause:** No explicit discriminator field on the `AuditFinding` interface; the fix logic relied on substring matching against a human-readable message that contained unrelated data (the directory name).

**Fix:** Added `artifact?: "spec" | "plan" | "tasks"` to `AuditFinding`, set at creation time in `auditFeature()`, and switched the fix loop from `finding.message.includes("spec")` to `finding.artifact === "spec"`.

**Test coverage:** `audit.test.ts` (29 tests) includes a regression test that creates feature `001-tasks-view` with only `spec.md` and verifies `--fix` does not overcorrect `approvals.tasks.generated`.

### R-5: SessionState.phase typed as string vs Zod z.enum allowing silent interface-schema divergence

**Introduced in:** Initial (interface and schema were always manual copies)
**Fixed in:** `7a8ccf0`

`SessionState.phase` was typed as `string` in the interface but `z.enum([...])` in the Zod schema. A typo like `"imp"` would pass TypeScript but be rejected by `safeParse` on the next `readSession`, silently resetting the entire session to `DEFAULT_SESSION`. Additionally, `writeSession`, `writeSpecJson`, and `writeConfig` serialized directly without validation, so invalid data would persist to disk before any read-side validation caught it.

**Root cause:** Manual duplication of type definitions across interface and Zod schema; no runtime validation gate on write paths.

**Fix:** Replaced all 4 manual interfaces (`SessionState`, `SpecJson`, `SDDConfig`, `ApprovalState`) with `export type Foo = z.infer<typeof FooSchema>` so the Zod schema is the single source of truth for both compile-time types and runtime validation. Added `safeParse` gates at the start of every write function, skipping the write on validation failure.

**Test coverage:** `shared-io.test.ts` verifies that writing invalid session/spec data skips the write and preserves the existing file.

### R-6: Direct fs.writeFile risked file corruption on interruption

**Introduced in:** Initial (all write functions used `fs.writeFile` directly)
**Fixed in:** `d7f4ac1`

`writeSession`, `writeSpecJson`, and `writeConfig` all called `fs.writeFile(fp, data)` directly. If the process was interrupted during the write (power loss, crash), the file would be left truncated or corrupt with no recovery option. For session.json in particular, corruption causes `safeParse` to return `DEFAULT_SESSION`, losing the user's working state.

**Root cause:** No atomic write pattern; direct mutation of the target file.

**Fix:** Added an `atomicWriteFile(fp, data)` helper that writes to `fp + ".tmp"` first, then atomically renames `.tmp` to `fp` via `fs.rename`. If the write or rename fails, the `.tmp` file is cleaned up and the original file is untouched. All three write functions now use this helper.

**Test coverage:** `shared-io.test.ts` verifies `.tmp` cleanup, overwrite correctness, parent directory creation, and empty content handling.

### R-7: Write functions throw on validation failure instead of silent skip

**Introduced in:** `96e8932`

`writeSession`, `writeSpecJson`, and `writeConfig` previously returned `void` on validation failure, silently skipping the write. This caused caller desync: the caller assumed data was persisted but it was not. All three functions now throw on `safeParse` failure, ensuring the caller knows the write was skipped.

Additionally, `opencode.jsonc` was sanitized — `C:\Users\ignac\` personal paths replaced with `~/.config/opencode/**` — and scraping/rate-limit patterns were added to `COMPLEXITY_KEYWORDS`.

**Test pattern:** Pass invalid data to each write function (e.g., `{ phase: "bogus" }` to `writeSession`) and assert that it throws with "validation failed" in the message.

### R-8: writeConfig lock, parsePhase init guard, isErrorWithCode type guard, nullish coalescing, AuditFinding type

**Introduced in:** `5bcf5f7`

Six hardening items in one round:

- **P-HIGH-1**: `writeConfig` acquired its own `acquireLock`/`releaseLock` internally (matching `writeSession` and `writeSpecJson`), removing the dependency on the caller's `withLock`.
- **P-MED-1**: `parsePhase("init")` now explicitly returns `"spec"` instead of silently falling through the `isPhase` check.
- **P-MED-2**: Three `isENOENT`/`isEEXIST`/`isESRCH` helpers replaced `(err as Record<string, unknown>).code` with a shared `isErrorWithCode` type guard, isolating the unsafe cast inside a single narrow function.
- **P-LOW-1**: `||` → `??` in `speckit-validate.ts` line 33.
- **P-LOW-2**: `args.taskDescription` now guarded with `?? ""` in `speckit-complexity.ts`.
- **P-LOW-3**: All 37 `(f: any)` in `audit.test.ts` replaced with `(f: AuditFinding)` after exporting the interface from `speckit-audit.ts`.

**Test pattern:** Each item has a focused regression test: `parsePhase("init")` returns `"spec"`, `isErrorWithCode` rejects non-Error values, `AuditFinding` is a typed interface importable from the audit tool.

### R-9: Remove string sniffing, `||` to `??` consistency

**Introduced in:** `c1deb64`

- `specJsonMismatches` in `speckit-clean.ts` changed from `issues.filter(i => i.includes("spec.json")).length` (string sniffing) to a direct counter incremented at the source during the loop.
- `||` → `??` in `speckit-config.ts` line 67 for consistency with line 61 (`args.defaultTechStack ?? null`).
- Added `parsePhase("init")` test.

### R-10: Resilience Layer — Backups, Transactions, and Corruption Warnings

**Introduced in:** `15018a1`, `1f30c7e`, `15e90c6`, `dd8374f`

Three interconnected features forming a resilience layer for state files:

#### R-10a: `writeWithBackup` — automatic pre-write backups

All write functions (`writeSession`, `writeSpecJson`, `writeConfig`) now use `writeWithBackup` instead of direct `atomicWriteFile`. Before writing, the helper reads the existing file content and saves it as `<file>.<timestamp>.bak` in `<project>/.opencode/backups/`. Old backups are trimmed to a maximum of 10. If the file does not exist yet, no backup is created.

**Rationale:** Any bug or incorrect `--fix` that corrupts state is recoverable by restoring the most recent `.bak` file.

**Test pattern:** Write to an existing file, verify `.bak` is created with the previous content. Write 15 times in sequence, verify only 10 backups remain. First write to a new file creates no backup.

#### R-10b: Two-phase commit in `/clean --fix`

The fix operation now follows a strict collect → validate → apply pattern:

1. **Collect**: Iterate all features, read spec.json, compute the correct phase and `ready_for_implementation` flag, store pending changes in memory.
2. **Validate**: Run `SpecJsonSchema.safeParse` on every pending spec.json. If ANY fails, throw before writing anything.
3. **Apply**: Write all validated spec.json files using `writeWithBackup`.

The session.json fix follows the same pattern: collect changes as callbacks, then apply atomically under a single lock.

**Rationale:** Prevents partial repairs. Before R-10b, if `/clean --fix --fix` was interrupted mid-loop, some features were repaired and others were not.

#### R-10c: `corruptionWarnings` global warning channel

A global `CorruptionWarning[]` array accumulates warnings whenever a `read*` function detects corruption:

- `readSession`: catches `JSON.parse` errors and `safeParse` failures, pushes warning (skips ENOENT — file not found is normal).
- `readSpecJson`: same pattern.
- `readConfig` (in `speckit-config.ts`): same pattern.

The `pushCorruptionWarning` helper also writes to `console.warn` with a `[SDD]` prefix. Tools that consume warnings:
- `/audit`: emits findings with `category: "corruption"`, `severity: "warn"`.
- `/status`: appends `[CORRUPTION]` lines to output and adds `[corruption detected]` to the title.

After consumption, each tool calls `clearCorruptionWarnings()`.

**Rationale:** Previously, corrupt state files were silently replaced with defaults. Users had no indication that their session or spec.json was corrupted.

**Test pattern:** Write invalid JSON to each state file, call the corresponding `read*` function, verify the warning array has an entry. Run `/audit` with corruption present, verify a `corruption` category finding exists. Run `/status` with corruption, verify output includes `[CORRUPTION]`. Delete the state file (ENOENT case), verify no warning is emitted.

#### R-10d: Integration tests for corruption edge cases

The `corruption.test.ts` file covers:
- Corrupt session.json (invalid JSON) → warning emitted, appears in audit
- Corrupt spec.json (invalid JSON) → warning emitted
- Corrupt config.json (invalid JSON) → warning emitted
- Empty session.json (SyntaxError from `JSON.parse("")`) → warning emitted
- Empty spec.json (SyntaxError) → warning emitted
- Valid files → no warnings
- `clearCorruptionWarnings()` resets the array
- Manual `pushCorruptionWarning` adds to the array

### R-11: Filesystem-root worktree scattered SDD state to the drive root

**Introduced in:** opencode workspace behavior (worktree = `/` for sessions without a project)
**Fixed in:** current

Sessions whose tool-context `worktree` was `/` resolved every state path to the drive root on Windows: SDD state landed in `C:\.opencode` and features in `C:\specs`, outside any project. Tools also loaded `guard.json` from the wrong root.

**Root cause:** Tools trusted `context.worktree` without validation. On Windows, `path.join("/", ".opencode")` resolves to the current drive root (`C:\.opencode`), and `isValidProjectRoot` passed because that directory happened to exist.

**Fix:** `resolveProjectRoot(context)` skips filesystem roots, falls back to `context.directory` (the session directory), and errors when no valid project directory exists. Applied to all tools; both plugins resolve their root via `pickProjectRoot`.

**Test coverage:** `project-root.test.ts` (resolver unit tests) and `project-root-gate.test.ts` (tool fallback + gate bypass).

### R-12: JSON state files rejected when written with a UTF-8 BOM

**Introduced in:** external tooling (PowerShell `Set-Content`/`Out-File` writes a BOM by default)
**Fixed in:** current

`config.json` (and potentially `session.json`/`spec.json`) written with a UTF-8 BOM failed `JSON.parse` ("Unrecognized token '﻿'"), so the kit silently fell back to defaults and emitted a corruption warning on every read. `speckit-config` updates were ignored.

**Root cause:** JSON reads called `JSON.parse` directly on file content; `\uFEFF` is not valid JSON. The kit's own writers never emit a BOM, but externally edited state files can.

**Fix:** `stripBom()` in `shared/io.ts` applied to every JSON parse site (session, config, spec.json, deltas index, guard config, perf, package.json, backup readers, plugin reads).

**Test coverage:** `bom-tolerance.test.ts` reads BOM-prefixed config/session/spec.json and asserts no corruption warnings.

### R-13: Undefined metadata values leave the V2 tool part stuck in running

**Introduced in:** the health scan findings of `speckit-selfheal`
**Fixed in:** current

On OpenCode 2 a tool whose result metadata carries an `undefined` value never completes its tool part. The part stays `running` forever, the stream emits no tool event, and the model receives the synthetic text "Tool result missing", so `speckit-selfheal` looked broken even though it executed in roughly fifteen milliseconds (perfmon recorded every call and its duration).

**Root cause:** the V2 runtime drops the part update when it serializes metadata that contains undefined values, and the audit loop built findings with `file: f.file as string | undefined`, leaving the key present with an undefined value whenever audit reported a finding without a file.

**Evidence:** payload bisection against the real CLI during the capability verification. A stub result and the JSON-cleaned findings payload complete; the raw findings payload and a minimal `{ total, ghost: undefined }` both stall.

**Fix:** findings only carry a file when audit reported one, and `toPluginContent` in `tools/plugins/speckit-tools.ts` JSON-cleans metadata before it reaches the runtime.

**Test coverage:** `selfheal.test.ts` asserts metadata survives a JSON round trip and the steering finding carries no file key; `plugin-v2-tools.test.ts` covers top level, nested and array undefined values.

### R-14: validate accepted a malformed featureDir and corrupted the session reference

**Introduced in:** the `featureDir` argument of `speckit-validate`
**Fixed in:** current

Passing `featureDir: "specs/001-name"`, a natural habit for models, produced a false "spec missing | plan missing | tasks missing" report and persisted the broken value into `session.json`, downgrading the stored phase from `impl` to `spec`. Re-running validate with the bare `001-name` restored both values.

**Root cause:** unlike `speckit-delta`, validate never checked the name with `isSafeFeatureDirName` before joining it to the specs directory and writing the session.

**Fix:** validate rejects a path shaped `featureDir` with `Invalid featureDir: ...` before any session write, mirroring delta.

**Test coverage:** `validate.test.ts` rejects prefixed, traversing, separator bearing and empty names, and asserts the session file stays untouched.

### R-15: clean and audit repaired the phase with next-step semantics and flagged healthy mid-workflow features

**Introduced in:** the phase detection of `speckit-clean` and the auto-repair path of both tools
**Fixed in:** current

`/clean` reported the stored phase as different from reality for every healthy feature that had not finished the workflow yet, so a spec only or spec plus plan feature was flagged as drift and `clean --fix` advanced the stored phase past the artifacts that were still being written. `audit --fix` and the clean repair also wrote the next-step phase into spec.json, so a feature that stored `tasks` produced a mismatch against itself on the next run, reported as "says tasks but tasks.md is missing".

**Root cause:** `detectPhaseFromFiles` answers which phase runs next from the artifacts on disk, while the stored phase means the last milestone reached. The clean detection, the clean repair and the audit repair all reused the next-step answer as if it were the milestone answer.

**Fix:** `phaseFromArtifacts(specOk, planOk, tasksOk, tasksApproved)` in `tools/shared/types.ts` derives the milestone phase. Clean now flags only genuine drift, keeps an `impl` or `complete` phase when every file exists, records session repairs in the trace with a no-op apply so the run still reports them, and targets the authoritative `liveSj.phase` when it realigns the session. Audit computes its repair target inside the lock from the freshly read spec.json.

**Test coverage:** `clean.test.ts` covers mid-workflow features, no advancement on fix, stale session realignment and the rule that a fix never promotes the phase without the tasks approval; `audit.test.ts` pins the exact repair target and the lost-artifact repair; `snapshot-triggers.test.ts` and `e2e-workflow-snapshots.test.ts` pin the repaired states; the new `property-phase-machine.test.ts` restates the coherence rules as invariants over generated command sequences.

### R-16: A fresh dependency resolution crashed the packed install on npm 10.9.8

**Introduced in:** the npm installer dependency step, which resolved the runtime tree inside the target directory
**Fixed in:** current

Installing the packed tarball with its dependencies enabled failed with `npm error Cannot read properties of null (reading 'edgesOut')`, raised inside `#loadPeerSet` in Arborist. `npx opencode-sdd-integrity@2.0.0 install` failed the same way on npm 10.9.8 while npm 11.16 succeeded, and replaying the install against npm 10.9.8 showed the failure on every run without a lockfile and a pass with either a lockfile present or `--legacy-peer-deps`, which pinned it to the fresh peer resolution of `@opencode-ai/plugin@1.17.8` and its optional `@opentui/*` peers.

**Root cause:** `npm pack` strips `package-lock.json`, so the published tarball shipped no lock and the dependency install resolved the whole peer set from the registry, walking the npm 10.9.8 Arborist code path that dereferences a null peer set.

**Fix:** the repository lock is committed as `npm-shrinkwrap.json`, which `npm pack` keeps, and the surface ships it as a required copy and verify path, so the dependency install resolves from that lock on every npm version.

**Test coverage:** the `npm-linux` job installs the tarball produced by `npm pack` with its dependencies enabled on Node 22, where the bundled npm raised the Arborist error, and `installer.test.ts` pins the surface contract around the shrinkwrap.

### R-17: The release archive omitted the shrinkwrap the install surface requires

**Introduced in:** the release workflow archive step, which listed the shipped paths by hand
**Fixed in:** current

The `opencode-sdd-integrity-v2.0.1.tar.gz` asset attached to the GitHub Release carried every copied directory but not `npm-shrinkwrap.json`, because the tar command enumerated its inputs instead of reading `tools/install/surface.json`. An offline install from that archive therefore resolved dependencies without a lock and walked back into the npm 10.9.8 Arborist failure that R-16 fixed.

**Root cause:** the archive list and the install surface were two independent descriptions of the same file set, so adding the shrinkwrap to `surface.json` did not add it to the release asset.

**Fix:** the archive step now includes `npm-shrinkwrap.json`, and a `Verify release archive` step reads the tar listing and fails when any `copyFiles`, `copyDirs` or example path from `surface.json` is absent, so the contract stays single-sourced.

**Test coverage:** the release workflow refuses to attach an archive that is missing a surface path.

### R-18: OIDC trusted publishing failed on a case-sensitive owner mismatch and required a manual release

**Introduced in:** the npm trusted-publisher configuration for `opencode-sdd-integrity`, where the GitHub owner was stored as `nemryz` (lowercase) while the actual GitHub account is `Nemryz`
**Fixed in:** current

npm matches the GitHub owner **case-sensitively** while GitHub does not, so the trusted-publisher exchange returned `404 package not found`, which npm masked as `ENEEDAUTH` (`npm error code ENEEDAUTH`). The failure only surfaced after the v2.0.2 tag push, when the `release.yml` Publish step could not exchange the OIDC token for a publish token. Because the npm publisher identity fields are immutable, the broken configuration could not be edited in place; it had to be deleted and recreated with the exact casing `Nemryz`.

**Root cause:** the trusted-publisher form was filled with a lowercase owner (`nemryz`) that did not byte-match the claims carried by the GitHub OIDC token (`repository: Nemryz/opencode-sdd-integrity`). npm's exchange endpoint returns 404 when no publisher configuration matches the claims, and npm reports that 404 as an authentication error, hiding the real cause. A diagnostic run (`diagnose_oidc=true`) printed the exact claims and the masked `{"message":"OIDC token exchange error - package not found"}` response, which confirmed the mismatch.

**Fix:** recreated the trusted publisher with the exact GitHub casing (`Nemryz`), and added an on-demand release path to `release.yml`: `workflow_dispatch` inputs `tag` and `diagnose_oidc`, an OIDC handshake check (claims + exchange status, fatal) on every run, and a verbose `npm publish --dry-run` in diagnose mode that skips all side effects. The failed tag-push run could not be re-triggered with a fixed workflow, so v2.0.2 was published by dispatching `release.yml` on ref `V2` with `tag=v2.0.2` (checkout at the existing tag). The workflow now installs `npm@11` globally because Node 22's bundled npm 10.9 cannot perform OIDC exchange.

**Test coverage:** the OIDC handshake check runs on every release (tag push and dispatch) and fails fast with the claims printed, so a case mismatch or missing configuration is reported as a 404 instead of being masked as ENEEDAUTH. Actionlint validates the workflow syntax on push and pull request.

**Follow-up:** future releases need no manual steps — bump the version and push the tag, or dispatch `release.yml` with `tag=vX.Y.Z`. Optional (user, npm UI): confirm Settings → Trusted publishing shows Validated, and enable "Require two-factor authentication and disallow tokens" under Publishing access. Optional: bump `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` to v7 and `softprops/action-gh-release` to v3 with CI validation.

### R-19: A failed archive metadata write left the feature split between specs/ and archive/

**Introduced in:** the per-entry archive loop, which created the target directory, moved every entry with its own rename and wrote `archived_at` only after the last move
**Fixed in:** current

If the process stopped after moving some entries, or if the session or spec write failed after the source directory was emptied, the feature existed partly in `specs/` and partly in `archive/`. Re-running `/archive` could then archive the remainder under a new dated name, and the original archive kept a spec.json without `archived_at`.

**Root cause:** a directory move was modeled as a sequence of independent file operations with no transaction boundary, no source and target preconditions, and no journal to reverse the operations that had already run.

**Fix:** `speckit-archive` now builds one immutable `StatePlan`: preconditions cover the source tree hash, the absent target and the session file when it points at the feature; the plan contains one `rename-dir` operation and the metadata writes; `applyStatePlan` holds the global state lock, writes a journal with backups, executes the plan, checks the expected hash and rolls back on any failure. A target that appears between planning and applying rebuilds the plan once with the next suffix and then reports a conflict.

**Test coverage:** `state-apply.integration.test.ts` covers stale bases, preconditions, target collisions, tampered plans, concurrent applies and rollback after a failed spec write; `chaos-state.test.ts` injects failed session, checksum and journal writes; `state-recovery.integration.test.ts` restores an applying journal and keeps a failed rollback visible; `archive.integration.test.ts` asserts one directory rename; `archive-safety.test.ts` rejects traversal and symlinked sources or archive directories, preserves the source on `EXDEV`, rebuilds once when the target appears after planning, and serializes two archive calls.

### R-20: Auto-versioning committed a change that only touched lastUsedLanguage

**Introduced in:** the language-only skip in `tools/shared/state/config.ts`
**Fixed in:** 3.2.1

A configuration write that only changed `lastUsedLanguage` was meant to be reverted without a commit, but the skip never matched a pretty-printed diff. The check counted the `---` and `+++` file headers as changed lines, those headers do not contain `lastUsedLanguage`, and the every-line test therefore failed before the real content was considered.

**Root cause:** the diff filter selected every line starting with `+` or `-`, including the file headers, instead of selecting only added and removed content lines.

**Fix:** the filter excludes `+++` and `---` headers, so a language-only change is reverted and a real configuration change still commits with `auto: update config`.

**Test coverage:** `auto-commit-language.test.ts` proves the revert path and the commit path against a real temporary git repository.
