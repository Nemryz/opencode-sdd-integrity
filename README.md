# opencode SDD Kit

[![CI](https://github.com/Nemryz/opencode-sdd-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Nemryz/opencode-sdd-kit/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Tests](https://img.shields.io/badge/tests-2990-brightgreen.svg)]()
[![Mutation Testing](https://img.shields.io/badge/mutation-Stryker-blue.svg)]()
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)]()

Spec-Driven Development workflow for opencode. This toolkit implements a structured methodology that guides software features from initial specification through final implementation. Each phase produces a specific document, each document validates the prerequisites for the next step, and no phase can be bypassed without proper validation.

The system operates through sequential artifacts, phase gates, and automated quality checks. Features progress through specification, planning, task decomposition, and implementation. Every transition requires explicit approval, and the toolkit enforces these transitions through its validation layer.

## What Is This

opencode SDD Kit is a comprehensive development framework built as a collection of TypeScript tools, runtime plugins, and agent orchestration rules. It transforms the opencode CLI into a complete specification-driven development environment.

The toolkit manages the entire lifecycle of a software feature, from the moment you describe what you want to build, through the planning and task breakdown phases, until the implementation is complete and tested. Along the way, it maintains state, creates backups, validates consistency, and ensures that nothing falls through the cracks.

Unlike traditional development approaches where documentation and implementation diverge, this system keeps them synchronized. The specification becomes the source of truth, the plan becomes the technical blueprint, and the tasks become the execution roadmap. Every artifact references the others, and the toolkit validates these cross-references continuously.

## Core Principles

The toolkit enforces three fundamental principles through its constitution system. These principles are not optional guidelines, they are enforced constraints that shape every decision throughout the development process.

### Simplicity

Maximum three top-level projects. No future-proofing abstractions. When facing a choice between a simple solution and a sophisticated one, always select the simpler option. Build what is needed now, not what might be needed later. This constraint prevents the accumulation of unused code and ensures that every component serves a clear, immediate purpose.

### Anti-Abstraction

Utilize frameworks directly. No repository patterns, service locators, or wrapper layers unless the framework explicitly requires them. Direct ORM usage. Direct framework API calls. This principle eliminates unnecessary translation layers and ensures that the code remains transparent and debuggable.

### Integration-First Testing

Test against real dependencies, databases, APIs, filesystems. Utilize testcontainers or equivalent solutions. No mocking of external services. Every user story requires at minimum one integration test covering the happy path. This ensures that tests validate actual behavior rather than simulated interactions.

## Writing Conventions

These rules apply to every file in the repository, and a change that breaks one of them fails the suite rather than waiting for a review. They are written down here because the first contribution should already follow them.

### Language

Everything written in the repository is English, including code, comments, documentation, test names, branch names, and commit messages.
Cyrillic, Greek, kana, CJK ideographs, Hangul, and fullwidth forms never appear in source, and `npm run lint:lang` fails the build when they do, except inside string literals, where a test fixture may legitimately carry hostile unicode to exercise a validator.

### Comments

A comment occupies a single line and reads as prose about the mechanism, never as a label for the code.
Explain why the line exists and what it causes, because the code already says what it does, so `// Process the entries` adds nothing while `// Turns the snapshots folder into a plain file so snapshot creation fails with a filesystem error` tells the reader what to expect.
Vary the verbs and the connectors so a file does not read like a form filled in thirty times, and keep dashes, colons, and semicolons out of comments entirely, since they turn a sentence into a fragment.
A module that owns one responsibility states it once at the top, in the form of a single comment beginning with `This module owns`, so a reader knows the boundary before reading a line of it.

### Documentation

One H1 per document, then the remaining headings in the order a reader needs them.
Each paragraph, list item, and table row stays on one line, written as prose that explains the mechanism without cutting a sentence midway and without restating what the code shows.

### Tests

Reuse the helpers in `tools/test/helpers/assertions.ts` instead of rebuilding path handling in each file, and add a helper only when the same verification is repeated, never because one test needed it once.
Name a suite for the question it answers, where `*-mutation.test.ts` and `*-kill-survivors.test.ts` mean a directed suite that pins behavior on purpose and are not Stryker runs.
A probabilistic test asserts the rule the code really follows rather than a wish about it, because a property that passes for the wrong reason is worse than no property.

### What the guards cover

`tools/test/integration/shipped-surface.test.ts` protects what the package publishes, `tools/test/integration/mutation-batches.test.ts` protects the mutation workflow and its documented numbers, `tools/test/integration/language-lint.test.ts` protects the language rule, and `tools/test/integration/resource-resolution-guard.test.ts` fails when a tool starts resolving its own resources from the home or the working directory, which is the failure mode that hides on one machine and breaks on another.

## Capabilities

The toolkit provides a complete set of capabilities that cover every aspect of the specification-driven development workflow.

**Constitution.** Project governing principles such as Simplicity, Anti-Abstraction, and Integration-First testing, written into a single markdown file and enforced by the toolchain. The constitution serves as the foundational document that guides all subsequent decisions.

**Specification.** Feature specifications with prioritized user stories, Gherkin scenarios, acceptance criteria, edge cases, and measurable success metrics. Each specification defines what the feature should do and how its success will be measured.

**Planning.** Technology stack decisions backed by documented rationale, alternative comparisons, risk analysis, component boundaries, and architecture descriptions. The planning phase ensures that technical decisions are deliberate and justified.

**Task Decomposition.** Ordered tasks organized into phases with ASCII dependency maps, parallelization markers, boundary annotations, and explicit deliverable states. This phase breaks complex implementations into manageable, sequential steps.

**Review.** Cross-artifact consistency checks that compare specification, plan, and tasks against each other, producing severity-rated findings with ownership classification. The review ensures that all artifacts remain aligned throughout the development process.

**Implementation.** Sequential phase execution with integrated testing, agent delegation for complex tasks, and three routing tiers, simple, standard, complex, based on complexity scoring. This phase executes the plan while maintaining quality through continuous validation.

**Discovery.** Automatic project context detection including package manager identification, framework recognition, configuration file scanning, and dependency analysis. This capability allows the toolkit to adapt to your existing project structure without manual configuration.

**Express Mode.** An operational shortcut that skips conversational proposals when speed is preferred, controlled by a configuration toggle. This mode accelerates the workflow when you want direct artifact generation without confirmation dialogs.

**Status and Cleanup.** Workflow state tracking with automatic session repair when directories are moved, files are deleted, or specification phases fall out of sync with reality. This capability ensures that the system remains consistent even when external changes occur.

**Resilience.** Automatic backups with SHA-256 checksum verification, corruption detection with warning channels, and automatic restoration from valid backups when state files become unreadable. This layer protects your work against data corruption and accidental deletion.

**Snapshots and Restore.** Point-in-time snapshots of the entire SDD state with per-file SHA-256 manifests, integrity verification, a crash-safe restore journal with automatic rollback, sandboxed restore drills that prove restorability, pinned golden states, and value-aware retention. This capability provides whole-state recovery beyond per-file backups.

**Mutation Testing.** Continuous quality assurance through Stryker mutation testing, ensuring test suites catch real code changes and maintain high mutation scores across all source modules. This capability validates that the test suite itself is effective.

## Architecture

The system follows a plugin-based architecture where each tool operates as a self-contained TypeScript module registered through the opencode plugin interface. Tools communicate via shared state files and coordinate through the orchestration layer defined in AGENTS.md.

```
+---------------------------------------------------------------------+
|                       opencode Runtime                               |
+---------------------------------------------------------------------+
|  AGENTS.md (Workflow Orchestration)                                  |
+---------------------------------------------------------------------+
|  Skills Layer (6 skills + 3 shared rules)                            |
|  + speckit-constitution                                              |
|  + speckit-spec-writer                                               |
|  + speckit-plan-engineer                                             |
|  + speckit-task-decomposer                                           |
|  + speckit-implementer                                               |
|  + speckit-reviewer                                                  |
|  + rules/ (design principles, spec standards, task guidelines)       |
+---------------------------------------------------------------------+
|  Tools Layer (16 TypeScript modules)                                 |
|  + speckit-scaffold                                                  |
|  + speckit-validate                                                  |
|  + speckit-audit                                                     |
|  + speckit-clean                                                     |
|  + speckit-status                                                    |
|  + speckit-config                                                    |
|  + speckit-complexity                                                |
|  + speckit-selfheal                                                  |
|  + speckit-delta                                                     |
|  + speckit-perf                                                      |
|  + speckit-health                                                    |
|  + speckit-guard                                                     |
|  + speckit-approve                                                   |
|  + speckit-phase                                                     |
|  + speckit-snapshot                                                  |
|  + speckit-mutation                                                  |
|  + shared/ (io.ts, schemas.ts, types.ts, snapshot/)                  |
+---------------------------------------------------------------------+
|  Plugins Layer (3 runtime plugins)                                   |
|  + speckit-perfmon (performance monitoring)                          |
|  + speckit-guard (permission protection)                             |
|  + speckit-tools (V2 tool registration)                              |
+---------------------------------------------------------------------+
|  State Layer                                                         |
|  + session.json (workflow state)                                     |
|  + spec.json (feature metadata)                                      |
|  + config.json (SDD configuration)                                   |
|  + guard.json (permission rules)                                     |
|  + perf.json (performance statistics)                                |
|  + backups/ (with SHA-256 checksums)                                 |
|  + snapshots/ (point-in-time state with manifests)                   |
+---------------------------------------------------------------------+
```

### Architecture Layers Explained

**Skills Layer.** Contains the instruction files that guide AI agents through each phase of the workflow. Each skill file defines the exact steps an agent must follow, the artifacts it must produce, and the validation rules it must enforce. The three shared rule sets establish common standards that apply across multiple skills.

**Tools Layer.** Houses the TypeScript modules that implement the actual functionality. Each tool is a self-contained module that can be invoked independently through the opencode command system. The shared directory provides common I/O operations, Zod schemas for validation, and type definitions used across all tools.

**Plugins Layer.** Contains runtime plugins that intercept system events and add functionality transparently. Unlike tools, which require explicit invocation, plugins operate automatically in the background, monitoring performance, caching data, and protecting files without user intervention. On OpenCode 2 the layer also registers the sixteen tools, because that runtime reaches custom tools through the plugin API.

**State Layer.** Maintains all persistent data including workflow state, feature metadata, configuration settings, backup files, and point-in-time snapshots. This layer ensures continuity across sessions and provides the foundation for the resilience mechanisms.

## Directory Structure

The toolkit organizes its components into a clear directory hierarchy that separates concerns and facilitates maintenance.

```
~/.config/opencode/
  AGENTS.md              Workflow orchestration and agent definitions
  commands/              CLI command handlers (17 files)
  skills/                Skill instructions (6 skills plus shared rules)
  tools/                 TypeScript tool modules (16 files)
  tools/shared/          Shared modules (io.ts, schemas.ts, types.ts, snapshot/)
  tools/plugins/         Runtime plugins (3 files)
  tools/test/            Test suite (108 test files)
  templates/             Artifact templates (12 templates)
  docs/                  Reference documentation
```

### Directory Descriptions

**AGENTS.md** serves as the central orchestration document that defines agent roles, workflow phases, quality gates, and command references. Every skill and tool references this document for coordination.

**commands/** contains the CLI command handlers that process user input and route requests to the appropriate tools. These handlers parse arguments, validate inputs, and manage the interaction between the user and the toolkit.

**skills/** holds the instruction files that guide AI agents through each workflow phase. Each skill file provides step-by-step instructions, artifact templates, and validation rules. The rules subdirectory contains shared standards that apply across multiple skills.

**tools/** contains the TypeScript modules that implement the toolkit's functionality. Each tool operates independently but shares common utilities through the tools/shared directory.

**tools/shared/** provides the foundation modules used by all tools, including file I/O operations with backup and checksum support, Zod schemas for data validation, and TypeScript type definitions.

**tools/plugins/** houses the runtime plugins that extend the toolkit's functionality through event interception and automatic processing, together with the OpenCode 2 registration that exposes the sixteen tools through the plugin API.

**tools/test/** contains the complete test suite organized into unit, integration, and mutation test categories.

**templates/** provides the artifact templates used when creating new specifications, plans, tasks, and other documents. These templates ensure consistency across all generated artifacts.

**docs/** contains reference documentation, guides, and supplementary materials that explain the toolkit's architecture and usage patterns. `docs/testing.md` documents the test types, the multi-value matrix convention, and the per-module coverage inventory.

## Tools Reference

The toolkit includes fifteen specialized tools, each designed for a specific purpose within the workflow. All tools follow consistent patterns for input validation, error handling, and state management.

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
| speckit-health | Health monitoring with auto-repair and backup restoration |
| speckit-perf | Performance statistics collection and analysis |
| speckit-guard | File protection management with permission tiers |
| speckit-approve | Approves generated artifacts to unlock the next workflow phase |
| speckit-phase | Advances the feature phase to impl or complete after implementation |
| speckit-snapshot | Creates, inspects, restores, and prunes point-in-time snapshots of the SDD state |
| speckit-mutation | Lists, runs, and aggregates the mutation batches of the kit itself, which only works inside a checkout of the repository |

### Shared Modules

Four shared modules provide common functionality used across all tools:

**io.ts** handles all file operations including atomic writes, backup creation, checksum generation and verification, corruption detection, and automatic restoration from valid backups. This module ensures data integrity throughout the system.

**schemas.ts** defines Zod schemas for all state files including session.json, spec.json, config.json, and their associated sub-structures. These schemas validate data at both read and write times, catching errors before they corrupt state.

**types.ts** provides TypeScript type definitions, re-exports from schemas, phase detection utilities, project root validation, and helper functions for creating default data structures.

**snapshot.ts** implements the point-in-time snapshot system: scoped state collection, SHA-256 manifests, integrity verification, the crash-safe restore journal with rollback and recovery, sandboxed restore drills, pinning, and value-aware retention.

## Skills Reference

Six skills guide AI agents through the specification-driven development workflow. Each skill corresponds to a specific phase and produces the artifacts required for that phase.

| Skill | Phase | Function |
|-------|-------|----------|
| speckit-constitution | Init | Creates or updates project governing principles |
| speckit-spec-writer | Spec | Translates requirements into structured specifications |
| speckit-plan-engineer | Plan | Maps specifications to technology decisions |
| speckit-task-decomposer | Tasks | Breaks plans into ordered, actionable tasks |
| speckit-implementer | Impl | Executes tasks in dependency order |
| speckit-reviewer | Review | Validates cross-artifact consistency |

### Shared Rule Sets

Three shared rule sets in the skills/rules directory establish standards that apply across multiple skills:

**Design Principles** defines the Simplicity, Anti-Abstraction, and Integration-First testing principles that guide all architectural decisions.

**Spec Standards** establishes the format, structure, and content requirements for feature specifications including user stories, acceptance criteria, and success metrics.

**Task Guidelines** defines the task decomposition format, dependency notation, parallelization markers, and boundary annotation conventions.

## Plugins

The toolkit extends its functionality through runtime plugins that intercept system events and perform automatic processing. Unlike tools, which require explicit invocation through commands, plugins operate transparently in the background, enhancing the development experience without interrupting your workflow.

### What Are Plugins

Plugins are TypeScript modules that register event handlers with the opencode runtime. They intercept specific system events such as tool execution, permission requests, and command processing. When an event occurs, the plugin's handler function executes, allowing it to monitor, modify, or prevent the event.

The fundamental difference between plugins and tools lies in their invocation pattern. Tools require explicit user commands like `/audit` or `/validate`. Plugins activate automatically whenever their registered events occur. A performance monitoring plugin tracks every tool execution without being asked. A protection plugin blocks unauthorized file modifications proactively.

This distinction enables plugins to provide system-wide functionality that operates consistently across all tools and workflows. You do not need to remember to invoke them, they simply work.

### How Plugins Work

The opencode runtime provides several hook points where plugins can intercept events:

**tool.execute.before** fires before any tool execution. Plugins can use this to prepare caches, log performance metrics, or validate permissions.

**tool.execute.after** fires after a tool completes. Plugins can use this to record timing data, update caches, or perform post-execution validation.

**permission.ask** fires when a tool requests permission for a restricted operation. Plugins can use this to implement protection rules, require approvals, or deny dangerous actions.

**event** fires for various system events. Plugins can use this to respond to configuration changes, session updates, or other system state transitions.

**command.execute.before** fires before a command is processed. Plugins can use this to validate inputs, modify arguments, or prevent command execution.

OpenCode 2 exposes the same interception points through domain hooks registered inside `setup`, namely `ctx.tool.hook("execute.before")`, `ctx.tool.hook("execute.after")`, `ctx.permission.hook("evaluate")`, and `ctx.event.subscribe()`. Tool definitions are added with `ctx.tool.transform()`.

When multiple plugins register for the same hook, they execute in registration order. Each plugin receives the same event data and can modify the processing pipeline. This chain of handlers allows plugins to compose and layer functionality.

### Available Plugins

The toolkit includes three production-ready plugins that address common development needs:

| Plugin | Hooks | Purpose | Configuration |
|--------|-------|---------|---------------|
| speckit-perfmon | tool.execute.before, tool.execute.after | Performance monitoring and statistics | perf.json |
| speckit-guard | permission.ask | File protection with permission tiers | guard.json |
| speckit-tools | tool.transform (OpenCode 2) | Registers the sixteen speckit tools | none |

### Plugin Configuration

Plugins register through the opencode.jsonc configuration file. Copy the template to create your local configuration:

```
cp opencode.jsonc.example opencode.jsonc
```

OpenCode 2 registers the shipped plugins with no configuration entry, because the runtime discovers every direct plugin file inside the plugins folder of the configuration directory. That discovery covers both clone and script installations.

OpenCode 1 uses the singular `plugin` field instead, and its tools load directly from the tools directory, so `speckit-tools` only applies to OpenCode 2.

The plugins array remains available for custom setups, and it only accepts plugin directories or package names, because file paths are ignored with a configuration warning:

```json
{
  "plugins": [
    "./my-plugin-directory",
    "opencode-acme-plugin"
  ]
}
```

To disable a plugin, remove its file from the plugins folder. The toolkit continues functioning normally with any combination of plugins enabled or disabled.

Each plugin maintains its own configuration file in the .opencode directory. These files store runtime state, accumulated statistics, and user-defined rules. The plugins manage these files automatically, but you can edit them directly if needed.

### Creating Your Own Plugin

Building a custom plugin requires understanding the hook system and following the established patterns. Here is a step-by-step guide:

**Step 1: Create the plugin file.** Place your plugin in the tools/plugins directory following the naming convention `speckit-yourplugin.ts`.

**Step 2: Define the plugin interface.** Export an object with an `id` string and a `server` function that receives the context and returns hook handlers:

```typescript
import type { Plugin } from "@opencode-ai/plugin"

const yourPlugin: Plugin = async (input) => {
  return {
    "tool.execute.before": async (event, output) => {
      // Execute before tool runs
    },
    "tool.execute.after": async (event, output) => {
      // Execute after tool completes
    }
  }
}

export default { id: "speckit-yourplugin", server: yourPlugin }
```

On OpenCode 2 the same export adds a `setup` function, which registers hooks, transforms, and tools through the plugin context. The shipped plugins under tools/plugins show both entrypoints together.

**Step 3: Register the plugin.** On OpenCode 2 the runtime discovers the direct files inside the plugins folder of the configuration directory, so re-export the implementation from a file next to the shipped shims:

```typescript
export { default } from "../tools/plugins/speckit-yourplugin"
```

Custom plugin directories and packages load through the plugins array in opencode.jsonc, which resolves paths relative to the configuration file:

```json
{
  "plugins": [
    "./my-plugin-directory"
  ]
}
```

On OpenCode 1 the field is the singular `plugin`.

**Step 4: Test your plugin.** Create unit tests for individual hook handlers and integration tests that verify the plugin interacts correctly with the opencode runtime.

### Plugin Testing

Each plugin undergoes three levels of testing to ensure reliability and correctness:

**Unit Tests** verify individual hook handlers in isolation. They create mock event data and validate that the handler produces expected side effects, cache updates, permission decisions, or performance records.

**Integration Tests** verify that plugins interact correctly with the opencode runtime and other toolkit components. They simulate complete tool execution cycles and validate that plugins intercept events at the correct points in the processing pipeline.

**Mutation Tests** verify that the test suite effectively catches code changes. Stryker introduces small modifications to plugin logic and validates that tests detect and fail on each mutation. This ensures that the tests provide meaningful coverage rather than superficial assertions.

## Installation

The toolkit requires opencode to be installed first. Follow the instructions at opencode.ai to set up the base CLI.

### Standard Installation

Clone this repository into your opencode configuration directory:

```
git clone https://github.com/Nemryz/opencode-sdd-kit.git ~/.config/opencode
cd ~/.config/opencode && npm install
```

### Platform-Specific Scripts

Both scripts clone the repository into the configuration directory, keep the previous copy of every file they replace in a timestamped `.install-backups` folder, and never overwrite an `opencode.jsonc` that already exists.

**Windows PowerShell:**

```
irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/master/install.ps1 | iex
```

**Linux or macOS:**

```
curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/master/install.sh | bash
```

The scripts accept the same options, and the example pair below installs the branch that supports OpenCode 2:

| Option | PowerShell | Shell | Default | Purpose |
|--------|------------|-------|---------|---------|
| Git ref | `-Ref` | `--ref` | `master` | Branch or tag to install, such as `V2` |
| Config dir | `-Dir` | `--dir` | `~/.config/opencode` | Directory that receives the toolkit |
| Skip deps | `-SkipDeps` | `--skip-deps` | off | Copy the files without running `npm install` |

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/V2/install.ps1))) -Ref V2
curl -fsSL https://raw.githubusercontent.com/Nemryz/opencode-sdd-kit/V2/install.sh | bash -s -- --ref V2
```

### Verification

Restart opencode for the changes to take effect. Run `/status` to verify that everything was installed correctly. The command should display the current workflow state without errors.

## Quick Start

After installation, the toolkit is ready to use. The following commands provide the essential workflow:

```
/status                         Show current workflow state
/spec <description>             Create a feature specification
/approve <artifact>             Approve spec, plan, or tasks to unlock the next phase
/plan <tech stack>              Create an implementation plan
/tasks                          Break the plan into actionable tasks
/review                         Check cross-artifact consistency
/impl [task-id]                 Execute implementation tasks
/steering [description]         Create or update steering context
/audit [--fix]                  Run comprehensive project audit
/clean [--fix]                  Scan and repair inconsistencies
/config key=value               Read or update configuration
```

### Workflow Walkthrough

A typical session progresses through the phases in order, each one producing a new artifact and updating the feature specification phase. Each artifact must be approved before the next command will proceed.

```
> /status
No features yet. Run /spec <description> to create the first feature.

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
Agent creates specs/001-task-management/tasks.md.
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

> /snapshot restore <id>
Agent shows the impact and asks for confirmation before touching anything.
restore complete, safety snapshot taken.
```

Each step validates the prerequisites before proceeding. The system prevents you from jumping ahead without completing the required artifacts and approvals, ensuring that every feature follows the complete development lifecycle.

Snapshots complement the workflow at any point: create one before risky operations, drill it to prove restorability, and restore it when something goes wrong. See State Management for the full command set.

## Workflow Deep Dive

Understanding how the workflow phases connect and validate each other provides insight into the system's reliability and consistency guarantees.

### Phase Transitions

The workflow progresses through seven distinct phases, each with specific entry requirements and exit conditions:

**Init** represents the starting state before any features exist. The toolkit detects this phase and suggests creating a constitution and first specification.

**Spec** indicates that a feature specification exists but has not been approved. The agent creates the specification document with user stories, acceptance criteria, and success metrics.

**Plan** indicates that the specification exists and has been approved, but the implementation plan has not been created. The agent produces a technology stack selection with documented rationale.

**Tasks** indicates that both specification and plan exist and have been approved, but the task breakdown has not been created. The agent decomposes the plan into ordered, actionable tasks.

**Ready** indicates that all three artifacts exist and have been approved, the feature is ready for implementation. The system validates that all prerequisites are satisfied before transitioning to this phase.

**Impl** indicates that implementation has begun. The agent executes tasks in dependency order, running tests after each phase and delegating complex tasks to sub-agents.

**Complete** indicates that all tasks have been implemented and tested. The feature has progressed through the entire lifecycle.

### Express Mode

Express Mode provides an acceleration path for experienced users who want to skip conversational proposals. When enabled, skills proceed directly to artifact generation without asking for confirmation first.

Enable Express Mode through configuration:

```
/config expressMode=true
```

When active, the spec-writer, plan-engineer, and task-decomposer skills generate their artifacts immediately upon invocation. This mode trades interaction for speed, producing complete documents in a single step.

Express Mode does not bypass validation. The generated artifacts still conform to all schema requirements, structural rules, and quality gates. It simply eliminates the intermediate conversation steps.

### Complexity Routing

The implementer evaluates each task and routes it through one of three tiers based on a numeric score. The score combines keyword analysis of the task description with four structured factors:

**File count.** One or fewer files adds no points, two to three files adds one point, four to eight files adds three points, and nine or more files adds five points.

**New dependencies.** Introducing new external dependencies adds three points.

**Boundary annotations.** Involving multiple `_Boundary:_` annotations adds two points.

**Ambiguity markers.** Unresolved `[NEEDS CLARIFICATION]` markers add two points.

The routing thresholds are: **simple** for scores up to two, **standard** for scores up to six, and **complex** above six. Simple tasks proceed directly to implementation, standard tasks follow the Test-Driven Development cycle, and complex tasks dispatch sub-agents for parallel work. Use the `speckit-complexity` tool to preview the score and reasoning for any task.

## State Management

The toolkit maintains state through several interconnected files that track workflow progress, feature metadata, and system configuration. Understanding how these files work together is essential for troubleshooting and customization.

### State Files

**session.json** tracks the current workflow state including active phase, working feature, command history, and session metadata. This file persists across tool invocations and enables the toolkit to resume exactly where you left off.

**spec.json** stores feature-specific metadata including phase, approval status, generated artifact flags, and delta tracking information. Each feature directory contains its own spec.json file that records the complete lifecycle of that feature.

**config.json** maintains SDD-specific configuration settings including default technology stack, express mode preference, auto versioning toggle, and user preferences. This file persists your choices across sessions.

**guard.json** stores permission rules for file protection including always-protected files, post-approval files, phase-based restrictions, denial logs, and protection statistics. This file accumulates rules as you approve files through the guard tool.

**perf.json** records performance statistics for all tool executions including call counts, execution times, percentile calculations, and historical trends. This file enables the performance monitoring plugin to track system health over time.

### Resilience Layer

The resilience layer operates through four interconnected mechanisms that protect your work against data corruption and accidental deletion.

**Automatic Backups.** Before any write to session.json, spec.json, config.json, or guard.json, the system reads the existing content and saves it as a timestamped .bak file in the .opencode/backups/ directory. Backups are grouped per source file and trimmed to a maximum of ten per source, ensuring that recent history is preserved without consuming excessive storage.

**Checksum Verification.** Each backup receives a SHA-256 checksum stored in a companion .sha256 file. When restoration is triggered, the system verifies the checksum matches before attempting to restore. This prevents restoring from corrupted backups that might cause additional problems.

**Corruption Detection.** Read operations validate JSON structure and Zod schema compliance. Invalid data triggers console warnings with a `[SDD]` prefix and accumulates in a global warning channel that feeds into audit and status output. This early detection system alerts you to problems before they cascade into data loss.

**Point-in-Time Snapshots.** Beyond per-file backups, the snapshot system captures the entire SDD state as one coherent unit with per-file SHA-256 manifests. Restores run through a verify, safety-snapshot, journal, apply sequence and roll back automatically on failure; orphan journals are recovered on the next run.

### Session Recovery

When the system detects inconsistencies between state files and the actual filesystem, it attempts automatic repair. If a session references a feature directory that no longer exists, the system clears the reference and resets to a neutral state. If a specification phase falls out of sync with the actual artifacts, the system recalculates the correct phase based on file presence.

This recovery process operates transparently during status checks and validation operations. You see the repaired state in the output, and the system logs the repair for audit purposes. Manual intervention is only required when the system cannot determine the correct state automatically.

### Snapshots and Restore

Snapshots capture the entire SDD working state at a point in time: core files (session.json, config.json, constitution.md, guard.json), every feature directory under specs/, and the steering documents. Each snapshot stores a manifest with the project-relative path, byte size, and SHA-256 checksum for every captured file, so integrity can be verified at any moment.

**Scope and exclusions.** Backups (.opencode/backups/), snapshots themselves, and transient files (*.lock, *.tmp, *.bak, *.sha256) are never captured. A snapshot of a project without features or steering documents still succeeds with the core files that exist.

**Restore safety.** A restore always runs through the same sequence: verify the snapshot, take a pre-restore safety snapshot, write a restore journal, apply the changes, and clear the journal on success. If anything fails mid-apply, the system rolls back from the safety snapshot. If the process is killed, the next run detects the orphan journal and recovers automatically.

**Restore drill.** The drill command restores a snapshot into a temporary sandbox outside the project, verifies every hash, and records the result. Drills prove that a snapshot is actually restorable without touching your project.

**Pinning and retention.** Manual snapshots can be pinned with a label to create a golden state that retention never removes. Automatic retention keeps at most five automatic snapshots per feature and ten snapshots in total, pruning lower-value triggers first (pre-fix before pre-restore before phase transitions) and never removing the newest snapshot or the last drilled snapshot.

**Recovery readiness.** The list command reports a single readiness verdict. READY means a verified snapshot exists and was drilled. DEGRADED means retention is over its caps or no snapshot has been drilled yet. NOT READY means an interrupted restore is pending or the newest snapshot failed verification.

**Automatic triggers.** The system takes a verified snapshot before every risky operation: phase transitions, tasks approval, and any --fix run (audit, clean, health, and selfheal through inheritance). If the state is unchanged since the newest snapshot, that snapshot is reused instead of creating a duplicate, and every automatic snapshot is drilled in a sandbox before the operation proceeds. If the snapshot cannot be created or fails its drill, the operation is blocked and nothing changes. When a fix fails partway, a best-effort post-failure snapshot preserves the broken state for forensics.

**Recovery integration.** /health reports pending interrupted restores, recovers them with --fix, restores a corrupted guard.json from backup, and includes the recovery readiness verdict in its report. /status warns when an interrupted restore is pending.

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

The toolkit provides several configuration options that control its behavior. These settings persist across sessions and can be modified through the `/config` command or by editing the configuration file directly.

### Configuration Settings

| Setting | Default | Description |
|---------|---------|-------------|
| defaultTechStack | none | Preferred technology stack for /plan |
| expressMode | false | Skip conversational proposals |
| autoVersioning | false | Automatic git commit on state writes |
| lastUsedLanguage | none | Previously used programming language |
| preferences | {} | User-defined key-value pairs |

### Configuration File

The configuration file lives at .opencode/spec-memory/config.json and follows the Zod schema defined in the toolkit. The `/config` command reads and writes this file with full validation.

To read the current configuration:

```
/config
```

To update a specific setting:

```
/config defaultTechStack=Node.js+PostgreSQL
/config expressMode=true
```

### opencode.jsonc Configuration

The opencode.jsonc file controls the opencode runtime itself, including model selection, permission rules, and plugin registration. Copy the template to create your local configuration:

```
cp opencode.jsonc.example opencode.jsonc
```

This file defines which models to use for different agent roles, which plugins to activate, and what permissions to grant. Refer to the opencode documentation for the complete configuration reference.

## Test Suite

The project includes 2990 automated tests distributed across 108 test files, and every layer answers a different question about the same system.
`docs/testing.md` holds the conventions, the per module matrix inventory, and the stability rules that this section only summarizes.

### Test Types

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
| Smoke | `tools/test/smoke/` | Does the real OpenCode 2 CLI load the shipped wiring |
| Install | `tools/test/install/` | Do the installers leave the promised surface and back up what they replace |

Content assertion and phase gate tests live in the unit and integration directories, where they verify that skills, templates, commands, and their prerequisites keep the structure the agents depend on.

### Value Matrices

Pure functions and behavioral rules carry `it.each` tables that vary values across five families, namely boundary, invalid, unicode, structural, and platform.
The tables encode the behavior the code actually has rather than the behavior it was assumed to have, and the reason is written beside any case where the two disagreed.
This is how a single scenario became 305 additional cases across the snapshot engine, the shared utilities, the guard matchers, and the state schemas.

### Verification Helpers

`tools/test/helpers/assertions.ts` centralizes disk verification so tests read the real state files instead of rebuilding path logic in every test.
The helpers assert presence, absence, exact bytes, schema validity, session and feature state, snapshot identity, backup counts, and pending restores.
Every integration test in the campaign uses them, which is what makes a tool that reports success without writing anything fail.

### Workflow Coverage

`tools/test/integration/e2e-workflow-snapshots.test.ts` walks the full lifecycle and asserts the recovery points created at every stage, the repair run that realigns a phase, the recovery of an interrupted restore, the restore to an earlier milestone, and the refusal to change state when a recovery point cannot be created.

### Platform-Dependent Tests

Case insensitive matching and Windows error formatting cannot be reproduced on Linux, so those cases use `it.skipIf(process.platform ...)` with the reason written next to them, and a bare `it.skip` is never accepted because an unexplained skip hides a regression.

### Stability Rules

Transient rename failures are retried, teardown tolerates the Windows busy codes, parallel filesystem mutations stay sequential, and global state is cleared between tests.
A stable suite is confirmed by running it more than once and by running it without file parallelism, which is how hidden order dependence was ruled out during the campaign.

### Smoke Run

```bash
tools/test/smoke/v2-smoke.sh
```

The script installs the kit into an isolated config home, boots the OpenCode 2 CLI, and grades the plugin markers, the tool registry, and the guard denial.
It expects the OpenCode 2 CLI on the PATH and treats the model evidence as a warning unless SMOKE_LLM_REQUIRED=1 is set.

### Language Lint

```bash
npm run lint:lang
```

The lint walks every tracked source file and fails when Cyrillic, Greek, kana, CJK ideographs, Hangul, or fullwidth forms appear outside string literals, while unicode literals inside fixtures stay allowed because they are the subject under test.

## Mutation Testing

The project utilizes Stryker mutation testing to measure test suite effectiveness. Mutation testing introduces small code changes, called mutants, and verifies that tests catch them. A high mutation score indicates that tests are sensitive to real code changes and provide meaningful coverage.

### Source Modules Under Mutation Testing

| Module | Purpose |
|--------|---------|
| shared/io.ts | File I/O operations, backup management, corruption detection |
| shared/schemas.ts | Zod schema definitions for all state files |
| shared/types.ts | Re-exports, phase detection, project validation |
| shared/snapshot/paths.ts | Snapshot layout, sidecars, journal paths, scope collection, hashing |
| shared/snapshot/manifest.ts | Snapshot creation, manifest reading, verification and listing |
| shared/snapshot/restore.ts | Restore preview, transactional restore and interrupted restore recovery |
| shared/snapshot/retention.ts | Pinning, drills, pruning caps and recovery readiness |
| shared/snapshot/triggers.ts | Automatic recovery points before risky operations and after failures |
| speckit-scaffold | Feature directory and artifact creation |
| speckit-validate | Artifact existence validation |
| speckit-audit | Project audit with auto-fix capabilities |
| speckit-clean | Inconsistency detection and repair |
| speckit-delta | Incremental specification delta management |
| speckit-health | Health monitoring with auto-repair |
| speckit-complexity | Task complexity assessment |
| speckit-config | Configuration management |
| speckit-selfheal | Health scan and automatic repair |
| speckit-status | Workflow state reporting |
| speckit-guard | Permission management |
| speckit-approve | Artifact approval gate |
| speckit-phase | Feature phase transitions (impl, complete) |
| speckit-snapshot | Snapshot management with recovery readiness |
| speckit-perf | Performance statistics |
| plugins/speckit-perfmon | Performance monitoring plugin |
| plugins/speckit-guard | Permission protection plugin |

### Thresholds

Target thresholds ensure minimum quality standards:

- High threshold: 80% (modules below this require immediate attention)
- Low threshold: 60% (modules below this indicate systemic issues)

Run mutation testing with:

```
npx stryker run
```

The Stryker configuration in stryker.conf.json specifies which modules to mutate, which test files to execute, and what thresholds to enforce.

## Contributing

Contributions are welcome. The project maintains high standards for code quality, testing, and documentation to ensure reliability across all components.

### Code Style

Utilize TypeScript with strict mode enabled. No semicolons, no colons in comments, minimal periods. Use commas only for list separation. Follow the existing patterns in the codebase for naming conventions, import organization, and function structure.

Every file is written in English, and `npm run lint:lang` fails the build when Cyrillic, Greek, kana, CJK ideographs, Hangul, or fullwidth forms appear outside string literals.

Each comment occupies a single line and reads as narrative prose that explains the procedure with varied verbs and connectors, without labels, dashes, colons, or semicolons.

Documentation follows the same single line discipline, where every paragraph, list item, and table row stays on one line so the reader never loses the thread midway.

```ts
// Turns the snapshots folder into a plain file so snapshot creation fails with a filesystem error.
await fs.writeFile(snapshotDir(worktree), "blocked", "utf-8")
```

### Testing Requirements

All new features require integration tests that validate the complete workflow. Run `npm test` and `npm run typecheck` before committing. The test suite must pass completely with no warnings or skipped tests.

### Commit Messages

Use conventional commit format with clear, descriptive prefixes:

- `feat:` for new features
- `fix:` for bug corrections
- `docs:` for documentation changes
- `test:` for test additions or modifications
- `chore:` for maintenance tasks

### Architecture Guidelines

Tools must be self-contained. Shared logic belongs in tools/shared/. Avoid circular dependencies between modules. Each tool should be independently testable and deployable.

### Documentation

Update README.md when adding features or changing behavior. Keep examples current and ensure that all configuration options are documented. The documentation should reflect the actual state of the codebase.

Keep one H1 per document, group the rest by the order a reader needs them, and let H3 headings carry only the lists that become unreadable without a title.

Issues and pull requests are welcome at the GitHub repository.

## License

MIT
