# OpenCode SDD Integrity

[![CI](https://github.com/Nemryz/opencode-sdd-integrity/actions/workflows/test.yml/badge.svg)](https://github.com/Nemryz/opencode-sdd-integrity/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Tests](https://img.shields.io/badge/tests-3590-brightgreen.svg)]()
[![Mutation Testing](https://img.shields.io/badge/mutation-Stryker-blue.svg)]()
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)]()

Spec-Driven Development workflow for opencode. The toolkit turns a feature request into an approved specification, a technology plan, an ordered task list, and a tested implementation, and it refuses to let those artifacts run out of order.

The Integrity part of the name is the promise the workflow keeps. Your state files survive crashes and concurrent writes, the phase gates hold even when the model forgets them, every implementation task carries test evidence, and every restore proves itself before it touches your project. V2 is the default branch and the current line, built around the OpenCode 2 runtime, and V1 stays available for projects pinned to OpenCode 1.

## Install

The npm package is the recommended path. It carries the whole toolkit and an installer CLI, so the configuration directory is never populated by hand:

```
npx opencode-sdd-integrity install
```

The installer copies the kit files into the target directory, saves every file it replaces under `.install-backups/<timestamp>-<hex>/` before writing, runs `npm install` for the runtime dependencies, and verifies the promised surface before it reports success. The default target is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when that variable is unset, and the installer refuses a filesystem root, the home directory itself, the package directory, or a path that already exists as a file. A global `npm install -g opencode-sdd-integrity` exposes the same CLI as `opencode-sdd-integrity`.

| Option | Default | Purpose |
|--------|---------|---------|
| `--dir <path>` | `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` | Directory that receives the toolkit |
| `--skip-deps` | off | Copy the files without running `npm install` |
| `--yes` | off | Skip the confirmation prompt |
| `--json` | off | Print a machine readable result |
| `--dry-run` | off | Show what would be installed without copying anything |
| `--no-backup` | off | Skip backup creation on re-install |
| `--backup` | off | Force backup creation even on first install |
| `--verbose` | off | Print detailed debug output |

The CLI carries six commands. `install` copies the files and runs the dependency installer, `verify` checks an existing installation path by path, and `doctor` diagnoses installation health and suggests fixes. `init` chains install, verify and doctor for a first-time setup, `update` re-installs while preserving files you edited and reporting which ones it skipped or refreshed, and `backup` manages the saved copies through `list`, `restore <stamp>` and `prune`, where `--keep N` controls how many the prune keeps.

```
npx opencode-sdd-integrity init
npx opencode-sdd-integrity update
npx opencode-sdd-integrity backup list
npx opencode-sdd-integrity backup restore 20260102-030405-ab12cd34
```

Re-installing is safe by design. Every file that would be replaced is backed up to `.install-backups/<timestamp>-<hex>/` first, a manifest records what was written, and a second run over an unchanged installation reports that it was already up to date instead of touching anything. `verify` and `doctor --json` return structured results that a script can check with an exit code. The runtime requires Node.js 22 or newer and a working `opencode` installation, which the instructions at opencode.ai cover, and the CLI checks the Node version up front and names the requirement when it is missing.

When npm is not an option, the repository scripts work as a fallback and back up the files they replace the same way:

```
# Linux or macOS
curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-integrity/V2/install.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-integrity/V2/install.ps1 | iex
```

The scripts default to the V2 branch and accept three options:

| Option | PowerShell | Shell | Default | Purpose |
|--------|------------|-------|---------|---------|
| Git ref | `-Ref` | `--ref` | `V2` | Branch or tag to install, such as `V1` for the OpenCode 1 line |
| Config dir | `-Dir` | `--dir` | `~/.config/opencode` | Directory that receives the toolkit |
| Skip deps | `-SkipDeps` | `--skip-deps` | off | Copy the files without running `npm install` |

To install the OpenCode 1 line instead:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-integrity/V2/install.ps1))) -Ref V1
curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-integrity/V2/install.sh | bash -s -- --ref V1
```

A manual clone works too, and it is the shortest path when you want to track a branch yourself:

```
git clone https://github.com/Nemryz/opencode-sdd-integrity.git ~/.config/opencode
cd ~/.config/opencode && npm install
```

After any of these paths, restart opencode and run `/status`. The command should print the current workflow state without errors.

## Quick Start

The commands cover the whole lifecycle, and every artifact moves through an approval gate:

```
/status                         Show current workflow state
/explore <topic>                Explore an idea before writing a spec
/spec <description>             Create a feature specification
/approve <artifact>             Approve spec, plan, or tasks to unlock the next phase
/plan <tech stack>              Create an implementation plan
/tasks                          Break the plan into actionable tasks
/review                         Check cross-artifact consistency
/impl [task-id]                 Execute implementation tasks
/converge                       Verify implementation matches the spec
/archive [featureDir]           Move a completed feature to archive/
/discovery                      Analyze state and suggest the next action
/steering [description]         Create or update steering context
/audit [--fix]                  Run comprehensive project audit
/clean [--fix]                  Scan and repair inconsistencies
/health [--fix]                 Health scan with auto-repair
/guard [status|on|off|...]      Manage file protection
/delta-status [featureDir]      Show incremental spec deltas
/config key=value               Read or update configuration
/snapshot [create|...]          Point-in-time state snapshots
/lab [create|run|diff|...]      Isolated non-mutation test runs
/matrix [<batch> ...]           Run mutation testing batches
/baseline [aggregate]           Aggregate historical mutation scores
```

### A session from start to finish

```
> /status
No features yet. Run /spec <description> to create the first feature.

> /explore task management, maybe with users and projects
Agent asks clarifying questions, scans the codebase and proposes scope.
Exploration summary saved to .opencode/spec-memory/exploration.md. Next: /spec <refined description>

> /spec create a task management system with users and projects
Agent creates specs/001-task-management/spec.md.
Spec created. Next: /approve spec

> /approve spec
Agent summarizes the spec and asks for confirmation.
spec approved. Next: /plan <tech stack>

> /plan Node.js + PostgreSQL + React
Agent creates specs/001-task-management/plan.md.
Plan created. Next: /approve plan

> /approve plan
plan approved. Next: /tasks

> /tasks
Agent creates specs/001-task-management/tasks.md with boundary and dependency annotations.
Tasks created. Next: /approve tasks

> /approve tasks
tasks approved. Next: /impl or /review

> /review
Agent checks specification, plan, and tasks for consistency.
Review complete, 0 issues found. Ready for /impl

> /snapshot create
Agent captures the entire SDD state as a point-in-time snapshot.
Snapshot created. Next: /snapshot drill <id>

> /snapshot drill <id>
Drill passed: every file was restored and verified in a sandbox.

> /impl
Agent executes tasks in dependency order and records test evidence per task.
Implementation complete. Next: /converge

> /converge
Agent checks every acceptance criterion against the code, runs the test suite and reports.
CONVERGED: All acceptance criteria verified. Next: /archive

> /snapshot create
Agent captures the pre-archive state as a recovery point.
Snapshot created.

> /archive
Agent confirms the feature is complete, then moves it with one directory rename and journaled metadata to archive/2026-01-02-001-task-management.
Feature archived. Next: /status

> /discovery
Agent reads the session, scans specs/ and reports the state.
Discovery: no active feature. Recommended: /spec <description> to start the next feature
```

Before any command that writes state, the pre-validation step checks the prerequisites and refuses to proceed when something is missing, so the system prevents jumping ahead without the required artifacts and approvals. Snapshots complement the workflow at any point: create one before risky operations, drill it to prove restorability, and restore it when something goes wrong, as the State and Recovery section spells out. `/discovery` is the compass when the next step is unclear, and `/status` stays the cheapest way to see where a feature stands.

## What Integrity Means Here

Integrity in this toolkit is a property of four layers, and each layer has a mechanism the test suite exercises against a real filesystem rather than a promise in the documentation.

State integrity covers every file the workflow owns. `session.json`, `spec.json`, `config.json` and `guard.json` pass Zod validation on every read and every write, writes land through a temporary file rename so an interrupted process leaves the previous version untouched, and each write stores a timestamped backup with a SHA-256 checksum before it replaces anything.

Enforcement integrity keeps the workflow in charge of the workflow. Approvals are runtime gates rather than documentation: `/approve` requires an explicit confirmation before it unlocks the next phase, `/impl` refuses to run until tasks are approved, and every command pre-validates its own prerequisites. The guard plugin blocks editor writes and shell redirects that target protected state and names the rule that fired, and the doom-loop plugin warns at the third identical failure and blocks the fifth, so an agent cannot spin on a broken command.

Verification integrity ties every claim to evidence. Tool results are typed, errors name the cause and the next command, reports end in a decision a reader can act on, and implementation tasks record TDD evidence through `speckit-evidence`, so a green run stays attached to the task it proves. Lifecycle events land in `.opencode/spec-memory/events.jsonl`, which keeps a chronology of phase changes, approvals, convergence verdicts and archives that survives a session restart. The toolkit's own 3590 tests run on Linux and Windows in CI, macOS remains supported for local runs, and install, smoke and mutation jobs watch the packaging and the suite itself.

Recovery integrity assumes the worst and rehearses for it. `/health` and `/audit --fix` repair drift and corruption, `/health` reports a pending state transaction and `--fix` rolls it back, `/status` surfaces it without touching disk, an interrupted restore rolls back from its journal on the next run, and every restore proves itself first: the snapshot is verified, a drill restores it in a sandbox, a safety snapshot is taken, and the apply step rolls back automatically on failure.

The same discipline shapes the interface. A blocked user gets the cause and the next command instead of a dead end, and a confirmation spells out the impact before it asks:

```
[Error] Tasks are not approved for 001-showcase-demo. Run /approve tasks first.
[WRN] evidence-failing: 001-showcase-demo: latest evidence for T-002 is a failing run (npx vitest run, exit 1)
```

`docs/showcase.md` collects the full gallery, including the guard and doom-loop messages, and compares the surface with the other spec-driven kits.

## V1 and V2

One repository carries two lines, and the branch decides which runtime the toolkit is wired for.

| Aspect | V1 | V2 |
|--------|----|----|
| Place in the repository | the previous line | the default branch and current line |
| Runtime | OpenCode 1 | OpenCode 2, with the OpenCode 1 wiring still shipped in the same package |
| Plugin discovery | the singular `plugin` field | the plugins folder, discovered without a configuration entry |
| Tool registration | tools load from the tools directory | the `speckit-tools` plugin registers all nineteen through the plugin API |
| Install | scripts with `--ref V1` or `-Ref V1` | the npm installer CLI, and the scripts default to V2 |
| Surface | the earlier line, kept for stability | doom-loop protection, TDD evidence, the interface contract, installer backups and OpenCode 2 smoke coverage |

Choose V2 unless a project is pinned to OpenCode 1. The workflow itself is the same on both lines, with the constitution, the phase gates, the approval flow and the snapshot engine, so switching lines does not change the methodology.

## How the Workflow Works

The workflow runs in strict order, and the toolkit refuses to skip a phase. A constitution states the governing principles, a specification defines what to build, a plan maps it to technology, tasks break the plan into ordered work, a review checks the artifacts against each other, and implementation executes with tests after every phase. Before any of that, the toolkit detects the project context on its own, including the package manager, the framework, configuration files and dependencies, so it adapts to an existing repository without manual setup.

| Phase | Meaning | Moves on with |
|-------|---------|---------------|
| Init | No features exist yet | A constitution and the first specification |
| Spec | The specification exists but is not approved | `/approve spec` |
| Plan | The specification is approved, the plan is not | `/approve plan` |
| Tasks | Spec and plan are approved, the task list is not | `/approve tasks` |
| Ready | All three artifacts are approved | `/impl` or `/review` |
| Impl | Implementation has begun | Every task implemented and tested |
| Complete | The feature finished its lifecycle | Nothing further |

Around the gates, four helper commands keep the loop moving. `/explore` is a thinking-partner session before a specification exists, `/converge` verifies the implementation against the spec's acceptance criteria before completion is declared, `/archive` moves the finished feature to `archive/YYYY-MM-DD-NNN-slug/`, and `/discovery` reads the current state and recommends the next action when you are unsure where to go.

Approval is a runtime gate with an explicit confirmation step, so an agent cannot approve on your behalf:

```
[Confirm Approval] Approve spec for 001-showcase-demo? This records the approval and unlocks the next workflow phase. Ask the user to confirm, then re-run with confirmed: true.
```

Express Mode trades conversation for speed. `/config expressMode=true` makes the spec, plan and task skills generate their artifacts in one step, and every schema rule, structural requirement and quality gate still applies, so the mode removes the dialogue rather than the validation.

Complexity routing sends each implementation task through one of three tiers. File count contributes zero to five points, a new external dependency adds three, a boundary annotation adds two, and an unresolved `[NEEDS CLARIFICATION]` marker adds two. Scores up to two are simple, up to six are standard, and anything higher is complex. Simple tasks proceed directly, standard tasks follow the Test-Driven Development cycle, and complex tasks dispatch sub-agents for parallel work, while `speckit-complexity` previews the score and the reasoning for any task.

## Tools

Nineteen tools implement the workflow, each self-contained, each validating its inputs and returning a typed result, and each invocable on its own or through its command.

| Tool | Purpose |
|------|---------|
| speckit-scaffold | Creates feature directories and artifact files from templates |
| speckit-validate | Validates that required SDD artifacts exist and determines workflow phase |
| speckit-audit | Comprehensive project audit with auto-fix capabilities and corruption detection |
| speckit-clean | Scans all features for inconsistencies and repairs session state |
| speckit-status | Shows workflow state across all features with corruption warnings |
| speckit-config | Reads and writes SDD configuration with validation |
| speckit-complexity | Assesses task complexity for routing through the three-tier system |
| speckit-selfheal | Health scan with categorized findings and automatic repair |
| speckit-delta | Manages incremental specification deltas for existing features |
| speckit-evidence | Records TDD test evidence per task and reports coverage gaps |
| speckit-health | Health monitoring with auto-repair and backup restoration |
| speckit-perf | Performance statistics collection and analysis |
| speckit-guard | File protection management with permission tiers |
| speckit-approve | Approves generated artifacts to unlock the next workflow phase |
| speckit-phase | Advances the feature phase to impl or complete after implementation |
| speckit-archive | Archives a completed feature into `archive/YYYY-MM-DD-NNN-slug/` with collision handling and a journaled directory rename |
| speckit-snapshot | Creates, inspects, restores, and prunes point-in-time snapshots of the SDD state |
| speckit-lab | Creates an isolated git worktree, runs non-mutation test categories and profiles, and promotes reviewed patches |
| speckit-mutation | Lists, runs, and aggregates the mutation batches of the kit itself, which only works inside a checkout of the repository |

The shared layer keeps the tools consistent. `io.ts` stays the compatibility facade for focused slices that own errors, safe paths, checksums, locks, atomic replaces, backups, corruption warnings, frontmatter and diagnostics, while `state/` holds the session, spec and config writers plus the immutable plan, journaled apply and recovery modules. `schemas.ts` defines the Zod schemas for every state file, `types.ts` carries the re-exports, phase detection, project root validation and the default data helpers, and `snapshot/` implements the point-in-time engine with its manifests, journal, retention and automatic triggers.

## Skills

Ten skills guide the agent through the phases, and each one produces the artifacts its phase requires.

| Skill | Phase | Function |
|-------|-------|----------|
| speckit-explorer | Pre-spec | Explores an idea with the user and clarifies ambiguities before a specification exists |
| speckit-constitution | Init | Creates or updates project governing principles |
| speckit-spec-writer | Spec | Translates requirements into structured specifications |
| speckit-plan-engineer | Plan | Maps specifications to technology decisions |
| speckit-task-decomposer | Tasks | Breaks plans into ordered, actionable tasks |
| speckit-implementer | Impl | Executes tasks in dependency order |
| speckit-reviewer | Review | Validates cross-artifact consistency |
| speckit-converger | Post-impl | Checks every acceptance criterion against the implementation and reports convergence gaps |
| speckit-archiver | Complete | Moves finished features into the archive and keeps the specs index current |
| speckit-discovery | Any | Reads project state and recommends the next command |

Three shared rule sets in `skills/rules/` apply across them. Design Principles restates the Simplicity, Anti-Abstraction and Integration-First testing gates, Spec Standards fixes the format for user stories, acceptance criteria and success metrics, and Task Guidelines defines the decomposition format, the dependency notation and the parallelization markers.

## Plugins

Runtime plugins extend the toolkit itself rather than waiting for a command. They register event handlers with the opencode runtime and intercept tool execution, permission requests and configuration changes, which is how monitoring and protection keep working whether or not anyone remembers to invoke them.

The hook points differ per runtime. OpenCode 1 exposes `tool.execute.before`, `tool.execute.after`, `permission.ask`, `event` and `command.execute.before`. OpenCode 2 reaches the same moments through domain hooks registered inside `setup`, namely `ctx.tool.hook("execute.before")`, `ctx.tool.hook("execute.after")`, `ctx.permission.hook("evaluate")` and `ctx.event.subscribe()`, while `ctx.tool.transform()` adds tool definitions. Multiple plugins that register for one hook run in registration order.

Four plugins ship with the toolkit, and a fifth records the workflow as it happens:

| Plugin | Hooks | Purpose | Configuration |
|--------|-------|---------|---------------|
| speckit-perfmon | tool.execute.before, tool.execute.after | Performance monitoring and statistics | perf.json |
| speckit-guard | permission.ask | File protection with permission tiers | guard.json |
| speckit-doom-loop | tool.execute.before, tool.execute.after | Detects repeated failing tool calls, warns, then blocks the call | plugin options |
| speckit-events | tool.execute.after | Appends lifecycle events to `.opencode/spec-memory/events.jsonl` | none |
| speckit-tools | tool.transform (OpenCode 2) | Registers the nineteen speckit tools | none |

`speckit-doom-loop` tracks failures per session as a fingerprint of the tool name plus its arguments. The third identical failure injects a warning into the session, and the fifth marks the call so the next identical attempt is blocked with an explanation before it runs. A successful call clears the streak, streaks expire after ten minutes, the tracker keeps at most 256 fingerprints per session, and `enabled: false` turns the detector off.

`speckit-events` watches every tool result and writes one JSON line per captured event: phase changes from `speckit-phase`, approvals from `speckit-approve`, task completions from `speckit-evidence`, convergence and archive results, each stamped with an ISO timestamp and the active feature from `session.json`. The log is append-only and sits next to the other state files, so `/discovery` and a future session can explain how a project reached its current state without asking anyone to reconstruct it by hand.

Plugins register through `opencode.jsonc`. Copy the template to create your local configuration:

```
cp opencode.jsonc.example opencode.jsonc
```

OpenCode 2 registers the shipped plugins with no configuration entry, because the runtime discovers every direct plugin file inside the plugins folder of the configuration directory, and that discovery covers both clone and script installations. OpenCode 1 uses the singular `plugin` field instead, and its tools load directly from the tools directory, so `speckit-tools` only applies to OpenCode 2.

The `plugins` array remains available for custom setups, and it only accepts plugin directories or package names, because file paths are ignored with a configuration warning:

```json
{
  "plugins": [
    "./my-plugin-directory",
    "opencode-acme-plugin"
  ]
}
```

To disable a shipped plugin, remove its file from the plugins folder, and the toolkit continues working with any combination of plugins enabled or disabled.

A custom plugin follows the same shape as the shipped ones. Create an implementation under `tools/plugins/` that exports an object with an `id` and a `server` function, and on OpenCode 2 add a `setup` function that registers hooks, transforms and tools through the plugin context:

```typescript
import type { Plugin } from "@opencode-ai/plugin"

const yourPlugin: Plugin = async (input) => {
  return {
    "tool.execute.before": async (event, output) => {
      // Fires before the tool runs, which is where a guard can refuse the call.
    },
    "tool.execute.after": async (event, output) => {
      // Fires after the tool completes, which is where a monitor records the timing.
    }
  }
}

export default { id: "speckit-yourplugin", server: yourPlugin }
```

Next to the shipped shims, the plugins folder re-exports the implementation so the runtime discovers it:

```typescript
export { default } from "../tools/plugins/speckit-yourplugin"
```

## Architecture

The system follows a plugin-based architecture where each tool operates as a self-contained TypeScript module registered through the opencode plugin interface. Tools communicate via shared state files and coordinate through the orchestration layer defined in AGENTS.md.

```
+---------------------------------------------------------------------+
|                       opencode Runtime                               |
+---------------------------------------------------------------------+
|  AGENTS.md (Workflow Orchestration)                                  |
+---------------------------------------------------------------------+
|  Skills Layer (10 skills + 3 shared rules)                           |
|  + speckit-explorer                                                  |
|  + speckit-constitution                                              |
|  + speckit-spec-writer                                               |
|  + speckit-plan-engineer                                             |
|  + speckit-task-decomposer                                           |
|  + speckit-implementer                                               |
|  + speckit-reviewer                                                  |
|  + speckit-converger                                                 |
|  + speckit-archiver                                                  |
|  + speckit-discovery                                                 |
|  + rules/ (design principles, spec standards, task guidelines)       |
+---------------------------------------------------------------------+
|  Tools Layer (19 TypeScript modules)                                 |
|  + speckit-scaffold                                                  |
|  + speckit-validate                                                  |
|  + speckit-audit                                                     |
|  + speckit-archive                                                   |
|  + speckit-clean                                                     |
|  + speckit-status                                                    |
|  + speckit-config                                                    |
|  + speckit-complexity                                                |
|  + speckit-selfheal                                                  |
|  + speckit-delta                                                     |
|  + speckit-evidence                                                  |
|  + speckit-perf                                                      |
|  + speckit-health                                                    |
|  + speckit-guard                                                     |
|  + speckit-approve                                                   |
|  + speckit-phase                                                     |
|  + speckit-snapshot                                                  |
|  + speckit-lab                                                       |
|  + speckit-mutation                                                  |
|  + shared/ (io.ts, atomic, locks, backups, state/, snapshot/)        |
+---------------------------------------------------------------------+
|  Plugins Layer (5 runtime plugins)                                   |
|  + speckit-perfmon (performance monitoring)                          |
|  + speckit-guard (permission protection)                             |
|  + speckit-doom-loop (repeated failure detection)                    |
|  + speckit-events (lifecycle event log)                              |
|  + speckit-tools (OpenCode 2 tool registration)                      |
+---------------------------------------------------------------------+
|  State Layer                                                         |
|  + session.json (workflow state)                                     |
|  + spec.json (feature metadata)                                      |
|  + config.json (SDD configuration)                                   |
|  + guard.json (permission rules)                                     |
|  + perf.json (performance statistics)                                |
|  + events.jsonl (lifecycle chronology)                               |
|  + backups/ (with SHA-256 checksums)                                 |
|  + snapshots/ (point-in-time state with manifests)                   |
|  + transactions/ (apply journals and rollback backups)               |
+---------------------------------------------------------------------+
```

The skills layer contains the instruction files that walk an agent through each phase, together with the shared rule sets that standardize the artifacts across them. The tools layer houses the TypeScript modules that implement the workflow, each self-contained and backed by the shared utilities. The plugins layer holds the runtime plugins that intercept events automatically, and on OpenCode 2 it also registers the nineteen tools, because that runtime reaches custom tools through the plugin API. The state layer maintains workflow state, feature metadata, configuration, backups, snapshots and the event log, which is what lets a session resume and what the recovery mechanisms protect.

## Repository Layout

The installed toolkit mirrors the repository, and the same surface ships through the installer CLI, the scripts and the release archive:

```
~/.config/opencode/
  AGENTS.md              Workflow orchestration and agent definitions
  agents/                Shipped agent definitions (1 agent)
  commands/              CLI command handlers (22 files)
  skills/                Skill instructions (10 skills plus shared rules)
  plugins/               Plugin entrypoints that OpenCode 2 discovers directly
  tools/                 TypeScript tool modules (19 files)
  tools/shared/          Shared modules (io.ts, atomic, locks, backups, state/, snapshot/)
  tools/plugins/         Runtime plugin implementations (5 files)
  tools/install/         npm installer CLI and its surface contract
  tools/test/            Test suite (149 test files)
  templates/             Artifact templates (12 templates)
  docs/                  Reference documentation
```

`tools/install/` carries the npm installer CLI and `surface.json`, the single contract that the install scripts, the verify scripts and the CLI all read, so the promised surface cannot drift between them. `docs/testing.md` documents the test types, the multi-value matrix convention and the per-module inventory, `docs/state-transactions.md` records the prior art and the plan, journal and recovery contract behind archive writes, and `docs/showcase.md` captures the real tool outputs behind the interface contract.

## State and Recovery

The workflow persists everything in files under `.opencode/spec-memory/` and `specs/`, so a session resumes exactly where it stopped.

| File | Purpose |
|------|---------|
| `session.json` | Active phase, working feature, command history and session metadata |
| `spec.json` | Per-feature phase, approvals, artifact flags, delta tracking and convergence state |
| `config.json` | SDD settings such as the default technology stack and express mode |
| `guard.json` | Protection rules, the denial log and protection statistics |
| `perf.json` | Tool call counts, execution times and percentiles |
| `events.jsonl` | Append-only lifecycle log of phase changes, approvals, task completions, convergence verdicts and archives |

On top of the files, five mechanisms keep state intact. Every write stores a checksummed backup under `.opencode/backups/`, trimmed to ten per source file, reads validate the JSON structure and the Zod schema and warn through a `[SDD]` channel when something is corrupt, atomic writes use a unique sibling temp file and fsync before the rename so an operation that dies midway leaves the previous version in place, session, spec and config writers take the global state lock before their per-file lock, and point-in-time snapshots capture the whole SDD state as one unit. Archive does not move files one by one: it builds one immutable plan, applies it behind a journal and rolls back on any failed metadata write.

Snapshots record the core files, every feature directory under `specs/` and the steering documents, with a manifest that lists the project-relative path, size and SHA-256 checksum of every captured file, so integrity can be verified at any moment. Backups, snapshots themselves and transient files are never captured, and a snapshot of a project without features still succeeds with the core files that exist.

Restores run through one sequence: verify the snapshot, take a pre-restore safety snapshot, write a restore journal, apply the changes, and clear the journal on success. A failure mid-apply rolls back from the safety snapshot, and a process that is killed is recovered from the orphan journal on the next run. The drill command rehearses the whole restore in a sandbox outside the project and records the result, so a snapshot can prove it is restorable without touching your work.

Retention keeps at most five automatic snapshots per feature and ten in total, pruning lower-value triggers first (pre-fix before pre-restore before phase transitions) and never removing the newest snapshot or the last one drilled. Manual snapshots can be pinned as golden states that retention never removes. The list command reports one readiness verdict: READY when a verified snapshot was drilled, DEGRADED when a cap is exceeded or nothing was drilled yet, and NOT READY when an interrupted restore is pending or the newest snapshot failed verification.

Automatic snapshots run before every risky step: phase transitions, tasks approval, and any `--fix` run. When the state has not changed since the newest snapshot, that snapshot is reused, and every automatic snapshot is drilled in a sandbox before the operation proceeds. If the snapshot cannot be created or fails its drill, the operation is blocked and nothing changes, while a fix that fails partway leaves a post-failure snapshot for forensics. `/health` recovers interrupted restores with `--fix`, and `/status` warns when one is pending.

Session recovery closes the loop. When the session references a feature directory that no longer exists, the toolkit clears the reference and resets to a neutral state, and when a feature phase drifts from the artifacts on disk, the correct phase is recalculated. The repair shows up in the output and is logged for audit, so manual intervention is only required when the toolkit cannot determine the correct state on its own.

### Snapshot Commands

| Subcommand | Purpose |
|------------|---------|
| create | Capture a point-in-time snapshot of the current state |
| list | Show snapshots, verification status, pins, drills, and recovery readiness |
| verify | Recompute hashes and report mismatched or missing files |
| preview | Show what a restore would change without writing anything |
| restore | Restore a snapshot with confirmation, safety snapshot, and rollback |
| pin / unpin | Protect a snapshot from retention, optionally with a label |
| drill | Rehearse a restore in a sandbox and record the result |
| prune | Apply retention caps and report removed, protected, and unreadable entries |
| recover | Roll back an interrupted restore from its journal |

```
/snapshot create
/snapshot drill 20260102-030405-manual
/snapshot restore 20260102-030405-manual
```

## Configuration

The toolkit provides several settings that control its behavior, and they persist across sessions:

| Setting | Default | Description |
|---------|---------|-------------|
| defaultTechStack | none | Preferred technology stack for /plan |
| expressMode | false | Skip conversational proposals |
| autoVersioning | false | Automatic git commit on state writes |
| lastUsedLanguage | none | Previously used programming language |
| preferences | {} | User-defined key-value pairs |

The settings live in `.opencode/spec-memory/config.json` behind the Zod schema, and `/config` reads and writes the file with full validation:

```
/config
/config defaultTechStack=Node.js+PostgreSQL
/config expressMode=true
```

The `opencode.jsonc` file controls the opencode runtime itself, including model selection, permission rules and plugin registration. Copy the template with `cp opencode.jsonc.example opencode.jsonc` and refer to the opencode documentation for the complete reference.

## Troubleshooting

Most failures come with the cause and the command that fixes them, and the patterns below cover the ones the workflow produces most often. When a message names a command, running that command is the fix, and `/status` or `/discovery` always answer what state the project is really in.

A `[SDD]` warning in the output means a state file failed validation or lost its checksum, and the toolkit keeps the last good copy before every write, so `/health --fix` restores the file from backup and quotes what it repaired. A session that references a feature directory that no longer exists is cleared automatically, and a phase that drifts from the artifacts on disk is recalculated on the next read, both of which `/clean` reports when you want the tally instead of watching for it.

When `/archive` says a feature is not complete, `/converge` is the missing step, because archiving requires the implementation to finish with convergence recorded. The same command warns when a feature has not converged, and confirming the operation archives it anyway while the warning stays in the output. When the guard blocks an edit or a shell redirect, it names the rule that fired, and `/guard status` lists the protected files while `/guard off` suspends the protection.

An interrupted restore leaves a journal behind, and the next `/snapshot` command or `/health --fix` recovers from it, so nothing is half-applied. A `NOT READY` verdict from `/snapshot list` means a restore is pending or the newest snapshot failed verification, and `/snapshot recover` clears the first while `/snapshot drill <id>` proves the second.

Installer problems show up before anything is written. A Node version below 22 is refused with the requirement named, `doctor` checks the installation and suggests concrete fixes, and `update` refreshes files you have not edited while reporting the ones it skipped. Re-installing backs up every file it replaces under `.install-backups/`, and `backup restore <stamp>` brings the previous copy back.

## Development

The project is a TypeScript toolkit with no build step, governed by the same gates it ships. `npm test` runs the suite, `npm run typecheck` checks both projects, and `npm run lint:lang` enforces the language rule.

### Testing

The suite holds 3590 automated tests across 149 files, and every layer answers a different question about the same system:

| Type | Directory | Question it answers |
|------|-----------|---------------------|
| Unit | `tools/test/unit/` | Does this pure function compute the right value |
| Matrix | `tools/test/**/matrix-*.test.ts` | Does it compute the right value across many inputs |
| Integration | `tools/test/integration/` | Does the tool leave the filesystem in the right state |
| Workflow | `tools/test/integration/e2e-*.test.ts` | Does a whole command sequence hold together |
| Property | `tools/test/property/` | Does an invariant hold for generated inputs |
| Chaos | `tools/test/chaos/` | Does the system survive injected filesystem failures |
| Concurrency | `tools/test/concurrency/` | Does locking prevent corruption under parallel access |
| Fuzz | `tools/test/fuzz/` | Does every schema reject hostile values without crashing |
| Snapshot | `tools/test/snapshot/` | Does a command produce exactly this output |
| Mutation | `*-mutation.test.ts` and `*-kill-survivors.test.ts` | Do the tests notice when the logic changes |
| Shipped surface | `tools/test/integration/shipped-surface.test.ts` | Does the packaging still describe the repository truthfully |
| Smoke | `tools/test/smoke/` | Does the real OpenCode runtime load the shipped wiring |
| Migration | `tools/test/mcp/` and `tools/test/integration/migration-*.test.ts` | Does a V1 configuration move to V2 without losing state, agents or plugin origins |
| Install | `tools/test/install/` | Do the installers and the npm CLI leave the promised surface and back up what they replace |
| Lab | `tools/speckit-lab.ts` | Does a category or profile pass in a disposable worktree without touching the checkout |

The isolated lab runs the same categories under pressure from a git worktree, keeps its reports under `reports/lab`, prepares dependencies from the sandbox lockfile, and leaves promotion to an explicit confirmation. Promotion also refuses if the checkout HEAD moved after the sandbox was created. `docs/lab.md` documents the categories, profiles, exclusions, dependency and promotion rules; `/lab` drives the tool.

`docs/testing.md` holds the conventions, the per-module matrix inventory and the stability rules that this section only summarizes. Pure functions and behavioral rules carry `it.each` tables that vary values across boundary, invalid, unicode, structural and platform families, and every integration test verifies real state on disk through `tools/test/helpers/assertions.ts`, which is what makes a tool that reports success without writing anything fail. The workflow suite walks the full lifecycle in `tools/test/integration/e2e-workflow-snapshots.test.ts` and asserts the recovery points created at every stage, the repair run that realigns a phase, the recovery of an interrupted restore, and the refusal to change state when a recovery point cannot be created. Case insensitive and Windows-specific cases use `it.skipIf` with the reason written next to them, and a bare `it.skip` is never accepted because an unexplained skip hides a regression.

### Mutation Testing

Stryker introduces small code changes, called mutants, and verifies that the tests catch them, which is how the suite proves it is sensitive to real behavior rather than to its own assumptions. The thresholds are 80% high and 60% low, and `stryker.conf.json` specifies which modules to mutate, which test files to execute and which thresholds to enforce. The `/matrix` and `/baseline` commands run and aggregate the batches from inside a checkout of this repository, and `npx stryker run` drives a single run directly.

### Code Style and Commits

Every file in the repository is English, including code, comments, documentation, test names, branch names and commit messages, and `npm run lint:lang` fails the build when Cyrillic, Greek, kana, CJK ideographs, Hangul or fullwidth forms appear outside string literals, where a test fixture may legitimately carry hostile unicode to exercise a validator. TypeScript runs in strict mode without semicolons. Each comment occupies a single line and reads as narrative prose about the mechanism with varied verbs, without labels, dashes, colons or semicolons, and documentation follows the same one-line discipline so a paragraph, list item or table row never loses the thread midway, with one H1 per document and the remaining headings in the order a reader needs them.

Commit messages follow the conventional prefixes: `feat:`, `fix:`, `docs:`, `test:` and `chore:`. New behavior requires integration tests against a real filesystem, `npm test` and `npm run typecheck` must pass, and the test suite must run clean without unexplained skips. Tools stay self-contained, shared logic belongs in `tools/shared/`, and circular dependencies stay out. The guards in `tools/test/integration/` protect the packaging surface, the mutation numbers, the language rule and the resource resolution rule, so a change that breaks one of them fails the suite rather than waiting for review.

Issues and pull requests are welcome at the GitHub repository.

## License

MIT
