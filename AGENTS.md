# SDD Workflow — Spec-Driven Development

## Language

All artifacts (specs, plans, tasks, comments) are generated in English by default.
Commands, skill instructions, and system logic remain in English.
To change the output language, edit this section and update the prompt instructions accordingly.

---

## Workflow — Strict Order

You MUST follow this order. Never skip a phase.

1. **Constitution** — Project governing principles. Suggested by `/spec` if missing.
2. **Specification** (`/spec <desc>`) — Define WHAT and WHY. No implementation details.
3. **Planning** (`/plan <stack>`) — Map requirements to technology. Apply Constitution Gates.
4. **Tasks** (`/tasks`) — Break plan into actionable tasks with dependencies.
5. **Review** (`/review`) — Check cross-artifact consistency before implementation.
6. **Implementation** (`/impl`) — Execute tasks in dependency order.

**Approval gates:** each artifact must be approved before the next phase runs. Use `/approve spec` before `/plan`, `/approve plan` before `/tasks`, and `/approve tasks` before `/impl`. The pre-validation gates in the commands enforce this. The `speckit-approve` tool requires `confirmed: true` — the agent must ask the user first and must never approve on the user's behalf.

Support: `/status` — show concise current phase and next step.

### Optional: Clarify Phase
If the spec contains `[NEEDS CLARIFICATION]` markers, insert a dedicated **Clarify** step between /spec and /plan. The agent stops, presents each ambiguity to the user, and resolves all markers before proceeding to planning. This prevents cascading bad assumptions.

---

## Quality Gates — Non-Negotiable

### Simplicity Gate
Maximum 3 top-level projects. No future-proofing abstractions.
If in doubt, pick the simplest option. Build what is needed now, not what might be needed later.

### Anti-Abstraction Gate
Use frameworks directly. No repository patterns, service locators, or wrappers unless the framework explicitly requires them. Direct ORM usage. Direct framework API calls.

### Integration-First Testing
Test against real dependencies (database, API, filesystem). Use testcontainers or equivalent. No mocking of external services. Every user story requires at minimum one integration test covering the happy path.

---

## Commands

### `/steering [description]`
Create or update steering context documents. Loads `speckit-scaffold` tool with `template: "steering"`.
Creates `product.md`, `tech.md`, `structure.md` in `.opencode/steering/`.
All SDD skills load steering context automatically if it exists.

### `/spec <description>`
Create a feature specification. Loads `speckit-spec-writer` skill.
Scaffolds `specs/NNN-slug/spec.md` via `speckit-scaffold` tool.
If no constitution exists, suggest creating one. If no steering context exists, suggest `/steering`.
Focus on WHAT and WHY. Write Gherkin scenarios. Prioritize P1 (MVP) / P2 (important) / P3 (nice to have).
Mark ambiguous areas with `[NEEDS CLARIFICATION]`.

### `/approve <artifact>`
Approve a generated artifact (`spec`, `plan`, or `tasks`) to unlock the next phase. Uses `speckit-approve` tool.
`spec` unlocks `/plan`, `plan` unlocks `/tasks`, `tasks` unlocks `/impl` and sets the feature to ready.
Requires explicit user confirmation before approving.

### `/plan <tech stack>`
Create an implementation plan. Loads `speckit-plan-engineer` skill.
Pre-validates: spec must exist.
Creates `specs/NNN-slug/plan.md` plus optional `research.md`, `data-model.md`, `contracts/`.
Apply ALL Constitution Gates before writing. Document rationale for every technology choice.

### `/tasks`
Break plan into tasks. Loads `speckit-task-decomposer` skill.
Pre-validates: spec and plan must exist.
Creates `specs/NNN-slug/tasks.md` with phases, `[P]` parallel markers, and ASCII dependency map.

### `/impl [task-id]`
Execute implementation. Loads `speckit-implementer` skill.
Pre-validates: spec, plan, and tasks must exist.
Records the phase transition with `speckit-phase` (`impl` at start, `complete` after final verification).
Executes in dependency order. Run tests after each phase.
If task-id is specified, start from that task.

### `/review`
Review cross-artifact consistency. Loads `speckit-reviewer` skill.
Checks spec quality, plan quality, tasks quality, and cross-references.
Produces a report with severity ratings (HIGH / MED / LOW).

### `/status`
Show workflow state. Uses `speckit-status` tool.
Reports current phase and next step.

### `/clean`
Scan all features for inconsistencies. Uses `speckit-clean` tool.
Use `--fix` to auto-repair phase mismatches and stale session references.
Without `--fix`, runs as read-only report.

### `/audit [--fix]`
Run a comprehensive project audit for phase consistency and artifact health. Uses `speckit-audit` tool.
Reports error, warning, and info findings with severity ratings.
Use `--fix` to auto-repair phase mismatches in spec.json.

### `/config [key=key value=val|defaultTechStack=stack]`
Read or update SDD configuration. Uses `speckit-config` tool.
Examples: `/config defaultTechStack=Node.js+PostgreSQL` or `/config key=language value=python`

### `/guard [status|on|off|add <file>|remove <file>|log|debug on|off]`
Manage the file protection guard. Uses `speckit-guard` tool.
`off` and `remove` require user confirmation (`confirmed: true`).

### `/health [--fix]`
Check SDD state integrity and restore corrupted files from backups. Uses `speckit-health` tool.

### `/delta-status [featureDir]`
Show the status of incremental delta specs. Uses `speckit-delta` tool with `command: "delta-status"`.

### `/snapshot [create|list|verify <id>|preview <id>|restore <id>|pin <id> [label]|unpin <id>|drill <id>|prune|recover]`
Manage point-in-time snapshots of the SDD state. Uses `speckit-snapshot` tool.
Automatic verified snapshots run before phase transitions, tasks approval, and `--fix` operations (audit, clean, health, selfheal). If the snapshot fails, the operation is blocked and nothing changes; failed fixes leave a post-failure snapshot. `/health` recovers interrupted restores with `--fix`.
`restore` requires user confirmation (`confirmed: true`); `list` reports Recovery Readiness.

---

## Agent Roles — Tab-Switchable

### `build` (default) — Tab 1
Full access. Implements code, runs commands, edits files.
Use for: implementation, testing, debugging, refactoring.

### `plan` (built-in) — Tab 2
Read-only. All edits and bash commands require approval.
Use for: architecture review, planning sessions, code analysis without changes.

### `spec` (custom) — Tab 3
Read + skill access. Bash denied. Edit requires approval.
Use for: requirements analysis, specification writing, artifact review.
The `spec` agent has these skills available: `speckit-constitution`, `speckit-spec-writer`, `speckit-plan-engineer`, `speckit-task-decomposer`, `speckit-reviewer`.
It can invoke subagents `@speckit-reviewer` and `@explore`.

Switch with Tab. If you are in the wrong agent for the task, tell the user.

### Agent Model Tiers (Recommended)

For better cost/quality ratio, assign different models to different agents in your opencode.json:

| Agent | Model | Why |
|-------|-------|-----|
| `build` | Fast model (e.g., gpt-4o-mini, claude-haiku) | Rapid iteration, code generation |
| `plan` | Heavy reasoner (e.g., gpt-4o, claude-sonnet) | Architecture decisions, risk analysis |
| `spec` | Heavy reasoner (e.g., gpt-4o, claude-sonnet) | Requirements analysis, writing artifacts |

Example opencode.json config:
```
{
  "agent": {
    "build": { "model": "fast-model" },
    "plan":  { "model": "heavy-reasoner" },
    "spec":  { "model": "heavy-reasoner" }
  }
}
```

---

## Artifact Locations

```
Constitution:    .opencode/spec-memory/constitution.md
Feature state:   .opencode/spec-memory/session.json
Domain map:      .opencode/domain-map.md           — Glossary of domain terms (optional)
Steering:
  product.md     .opencode/steering/product.md     — Product context (optional)
  tech.md        .opencode/steering/tech.md        — Tech stack & ADRs (optional)
  structure.md   .opencode/steering/structure.md   — Code conventions (optional)

specs/
└── NNN-feature-name/
    ├── spec.md          — Feature specification (required)
    ├── plan.md          — Implementation plan (required)
    ├── tasks.md         — Task breakdown (required)
    ├── spec.json        — Feature state and approvals (required)
    ├── research.md      — Technology research (optional)
    ├── data-model.md    — Schema / entities (optional)
    ├── contracts/       — API contracts (optional)
    └── deltas/          — Incremental delta specs (optional)
        └── deltas.json  — Delta index
```

Templates:  `~/.config/opencode/templates/`
Skills:     `~/.config/opencode/skills/`
Tools:      `~/.config/opencode/tools/`

---

## Available Skills — Load on Demand

| Skill | Phase | Action |
|-------|-------|--------|
| `speckit-constitution` | 0 | Create or update project governing principles |
| `speckit-spec-writer` | 1 | Translate requirements into structured specs |
| `speckit-plan-engineer` | 2 | Map specs to technology decisions |
| `speckit-task-decomposer` | 3 | Break plans into ordered tasks |
| `speckit-implementer` | 4 | Execute tasks in dependency order |
| `speckit-reviewer` | all | Validate cross-artifact consistency |

Call a skill with: `skill({ name: "speckit-spec-writer" })`

---

## Available Tools — Call via Function

**Project-root warning gate:** tools that operate on the project root return a `Warning` result when the root looks risky (kit installation directory, system directory, or very shallow path). The agent must ask the user to confirm, then re-run the same tool with `confirmed: true`.

**Project root resolution:** tools resolve the project root from the session worktree, falling back to the session directory; filesystem roots (`/`, `C:\`) are never used. If no valid project directory exists, the tool errors — open opencode inside your project (`cd <project> && opencode`).

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `speckit-scaffold` | Create `specs/NNN-name/` artifacts, constitution, steering, or project docs | `featureName`, `template` (spec/plan/tasks/constitution/steering/data-model/domain-map/glossary/research/contracts), `techStack`, `overwrite` (bool) |
| `speckit-validate` | Check artifact existence and phase | `featureDir` (optional), `command` (optional) |
| `speckit-audit` | Run comprehensive project audit | `fix` (bool, optional) |
| `speckit-clean` | Scan all features and report inconsistencies | `fix` (bool, optional) |
| `speckit-config` | Read or update SDD configuration | `key`, `value`, `defaultTechStack` (all optional) |
| `speckit-status` | Report full workflow state | none |
| `speckit-complexity` | Assess task complexity for routing | `taskDescription`, `filesAffected`, `hasNewDependencies`, `hasBoundaryAnnotations`, `hasNeedsClarification`, `useProjectContext` |
| `speckit-selfheal` | Run health scan, analyze findings, apply fixes with rollback | `fix` (bool, optional) |
| `speckit-health` | Run health check, verify file integrity, restore from backups | `fix` (bool, optional) |
| `speckit-delta` | Create incremental delta specs for existing features | `command`, `description`, `deltaId`, `featureDir` |
| `speckit-perf` | Show performance statistics for all tools | `subcommand` (optional: "top N", "reset") |
| `speckit-guard` | Manage file protection guard for critical SDD artifacts | `subcommand` (optional: "on", "off", "status", "add", "remove", "log", "debug"), `file` (for add/remove), `confirmed` (bool, for off/remove after user confirmation), `logOption` (optional: "all"), `debugOption` (optional: "on", "off") |
| `speckit-approve` | Approve a generated artifact to unlock the next phase | `artifact` (spec/plan/tasks), `confirmed` (bool, after user confirmation) |
| `speckit-phase` | Advance the feature phase to impl or complete after implementation | `phase` (impl/complete) |
| `speckit-snapshot` | Create, inspect, restore, and prune point-in-time snapshots of the SDD state | `subcommand` (create/list/verify/preview/restore/pin/unpin/drill/prune/recover), `id` (or "latest"), `mode`, `files`, `label`, `confirmed` |

---

## Constitution Template

The constitution template lives in `~/.config/opencode/templates/constitution-template.md`.
Use `speckit-scaffold` with `template: "constitution"` to create one.

---

## Example Walkthrough

```
User: /status
Agent: "No features yet. Run `/spec <description>` to create the first feature."

User: /spec create an invoicing system with users, clients, products, and invoices
Agent: Loads speckit-spec-writer skill. Determines next number (001).
       Checks steering context — if missing, suggests /steering first.
       Creates specs/001-invoicing-system/spec.md via speckit-scaffold.
       "Spec created. Next: /approve spec"

User: /approve spec
Agent: Summarizes the spec, asks for confirmation, marks approvals.spec.approved.
       "spec approved. Next: /plan <tech stack>"

User: /plan Laravel + MySQL + Tailwind
Agent: Loads speckit-plan-engineer. Applies Constitution Gates.
       Creates specs/001-invoicing-system/plan.md.
       "Plan created. Next: /approve plan"

User: /approve plan
Agent: "plan approved. Next: /tasks"

User: /tasks
Agent: Loads speckit-task-decomposer.
       Creates specs/001-invoicing-system/tasks.md.
       "Tasks created. Next: /approve tasks"

User: /approve tasks
Agent: Marks tasks approved and sets the feature to ready.
       "tasks approved. Next: /impl or /review"

User: /impl
Agent: Loads speckit-implementer. Executes tasks phase by phase.
       Runs tests after each phase. Reports progress.
       "Implementation complete. Run /review to verify."
```

---

## Concise Output Rule (NON-NEGOTIABLE)

Agent chat responses MUST be 1-3 lines maximum in the `[Result] [Next: /command]` format. No status tables, no artifact listings, no checkmark trees, no verbose explanations.

**Exception**: report tools (`/review`, `/audit`, `/clean`, `/status`, `/health`, `/delta-status`, `/guard log`) produce structured multi-line output by design — relay them as-is and add at most one line of commentary.

### Format

```
[Result] [Next: /command]
```

Examples:
- `"spec.md created in specs/001-task-management/  Next: /plan <tech stack>"`
- `"spec ok | plan missing | tasks missing  Next: /plan <tech stack>"`
- `"Phase: plan | 1 feature(s) | Latest: 001-task-management  Next: /tasks"`

### How it works

- All detailed state is stored in `.opencode/spec-memory/session.json` (read/written by custom tools)
- Read session.json at the start of each interaction to recover context
- Do NOT dump session.json content to the chat
- If the user asks "what did we do so far?", read session.json.history and summarize in 1 line
- Tool results are already minimal; do not elaborate on them
- Never repeat what the tool just said in different words

## Critical Rules

1. NEVER start implementation without spec, plan, AND tasks.
2. If any required artifact is missing, tell the user what is needed and stop.
3. ALWAYS apply Constitution Gates before planning.
4. ALWAYS run tests after each implementation phase.
5. If the user asks for implementation while in the `spec` agent, suggest switching to `build`.
6. All artifacts are written in English by default.
7. The `[NEEDS CLARIFICATION]` marker means stop and ask the user before proceeding.
8. NEVER edit `spec.json`, `session.json`, `config.json` or `guard.json` by hand. Use the suite tools; the guard blocks direct edits to critical state files. The constitution is editable only while it still contains template placeholders — once filled it is protected, and editing it again requires `speckit-guard remove` with `confirmed: true` after the user approves. `speckit-guard off`/`remove` always require asking the user first, then re-invoking with `confirmed: true`.
9. If a phase gate blocks, tell the user which `/approve <artifact>` to run. Never self-approve — approval requires explicit user confirmation.
10. Resolve the model per session. `agent.<name>.model` is only a preference for when the agent is selected; switching agents does not change an existing session's model.

---

## Custom Tool Error Handling

Custom tools (`speckit-scaffold`, `speckit-validate`, `speckit-audit`, `speckit-clean`, `speckit-config`, `speckit-status`, `speckit-complexity`, `speckit-selfheal`, `speckit-health`, `speckit-delta`, `speckit-perf`, `speckit-approve`, `speckit-phase`, `speckit-snapshot`, `speckit-guard`) are TypeScript files compiled at runtime by opencode. If a tool has compilation errors, opencode may fail to start or crash on each prompt.

### If a tool crashes opencode

1. **Identify the broken file** — opencode will log which tool file failed to compile.
2. **Delete the broken tool file** from `~/.config/opencode/tools/`.
3. **Restart opencode** — it will work without the deleted tool.
4. **Report the issue** so the tool can be fixed:
   - Check the error for the specific line number and TypeScript error code.
   - Common causes: missing `node:` prefix in imports, unused variables, complex type inference.

### Authoring safe tools

- Every custom tool MUST wrap its `execute` body in a `try/catch` that returns a descriptive error string instead of crashing.
- Use `node:fs`, `node:path`, `node:os` import prefixes (`import fs from "node:fs/promises"`).
- Avoid complex type inference patterns (reduce with spread, conditional await chains).
- Prefer simple `for` loops over `.reduce()`, `.filter().map()` chains for type stability.

---

## Known Regression History

Moved to `docs/regressions.md` — read it before modifying `tools/shared/` or cross-tool behavior.

---

## Test Patterns

### Cold start bootstrap

Every new project follows the same entry path: `mkdir` → `git clone` → `opencode` → constitution → spec → plan → tasks. The `cold-start.test.ts` suite replicates this exact sequence starting from a raw `mkdtemp()` with no pre-created state. When adding new preconditions that require `.opencode/` subdirectories, add a corresponding cold-start test variant.

### Fallback template placeholders

Every scaffold fallback text MUST include its corresponding placeholder variable (`[PROJECT NAME]`, `[FEATURE NAME]`) so that `replace()` calls in production code produce the correct output. Files that reference the project name (`constitution`, `steering`, `domain-map`) use `[PROJECT NAME]`. Files that reference a feature (`data-model`, `research`) use `[FEATURE NAME]`. The `scaffold-fallback.test.ts` suite verifies each fallback contains the right placeholder.

### High risk boundary tests

High risk categories (C-1 through C-7 in `high-risk.test.ts`) cover cross-tool resilience: no worktree, corrupt JSON, invalid project root, ghost spec.json without its directory, concurrent scaffold calls, stale locks, and truncated session.json. These tests exercise every tool against the same failure scenario in a single describe block, so a single change to `isValidProjectRoot`, `readSpecJson`, or `readSession` is caught regardless of which tool calls it.

### Integration first, not unit first

Tests should hit real dependencies (filesystem, JSON files, directories). Mocks and pure-unit tests are reserved for pure functions like `slugify`, `parseNNN`, and `detectPhase`. Anything that reads or writes state must go through the real filesystem in a temp directory. This aligns with the Integration-First testing gate in the constitution.

### Zod schema validation for all JSON state files

Every `read*` function that parses a JSON file from disk MUST validate via Zod `safeParse` and return a safe fallback on failure. The pattern is:

1. Define an exported Zod schema object (e.g. `SessionStateSchema`, `SpecJsonSchema`, `ConfigSchema`)
2. Call `schema.safeParse(merged)` where `merged = { ...DEFAULT, ...parsed }`
3. On `result.success`, return **`result.data`** (NOT `merged`) to ensure Zod-stripped clean output
4. On failure, `console.warn` the ZodError and return the default object

This was regressed in `readConfig` (returned `merged` instead of `result.data`) and fixed in commit `5ad4beb`.

### CI must use `npm ci`, not `npm install`

All CI workflows MUST use `npm ci` instead of `npm install --ignore-scripts`. The `npm ci` command is stricter — it installs exactly from `package-lock.json` and fails if the lockfile is out of sync with `package.json`. This guarantees reproducible builds across platforms and avoids CI-only failures.

### Display-only phases must not be persisted to session.json

Tools that compute transient display values (e.g. `validateTool` returning `"empty"`, `statusTool` returning `"none"` or `"unknown"`) MUST NOT write those values to `s.phase` in session.json. The `SessionStateSchema.phase` enum only allows `"init"`, `"spec"`, `"plan"`, `"tasks"`, `"ready"`, `"impl"`, `"complete"`. Persisting a display value causes subsequent `readSession` to fail validation and return `DEFAULT_SESSION`, silently destroying the user's session state.

Fix: guard with `if (phase !== "empty")` (validate) or `if (phase !== "none" && phase !== "unknown")` (status).

### TypeScript types derived from Zod schemas via z.infer

Every persisted data structure must have exactly one source of truth — the Zod schema. Use `export type Foo = z.infer<typeof FooSchema>` instead of a manually maintained interface. This eliminates the risk of silent divergence between runtime validation and compile-time types. Additionally, validate data with `schema.safeParse()` at write time (defense-in-depth), so invalid data is caught at the write site rather than silently corrupting state.

**Reproduced in:** R-5 — `SessionState`, `SpecJson`, `SDDConfig`, and `ApprovalState` were all manual interfaces that could diverge from their Zod schemas.

**Test pattern:** Write invalid data via `as any` bypass and assert the existing file is preserved.

### Atomic file writes via tmp + rename

All write functions (`writeSession`, `writeSpecJson`, `writeConfig`) MUST use the `atomicWriteFile` helper instead of direct `fs.writeFile`. The helper writes to `fp + ".tmp"` first, then atomically renames `.tmp` to `fp` via `fs.rename`. If the write or rename fails, the `.tmp` file is cleaned up and the original file is untouched. This prevents file corruption on process interruption.

**Introduced in:** `d7f4ac1`.

**Test pattern:** Write to a temp path, verify the `.tmp` file is removed after success. Overwrite an existing file and verify content. Verify parent directories are created automatically.

### Flaky parallel filesystem tests

Tests using `Promise.all` with concurrent filesystem operations (directory creation, file locking) are inherently flaky across platforms. The C-5 test was changed from `Promise.all` to sequential calls after macOS CI failures. For parallel contention tests, use `Promise.allSettled` with tolerant assertions (e.g., `expect(successCount).toBeGreaterThanOrEqual(1)`) rather than strict `expect(r1.title).not.toBe("Error")`.

### Explicit discriminator fields on fixable findings

When a fix loop needs to distinguish between multiple sub-items (e.g., spec/plan/tasks approvals), add an explicit discriminator field to the finding interface (e.g., `artifact?: "spec" | "plan" | "tasks"`) rather than string-sniffing on the human-readable message. String matching on `finding.message.includes("spec")` is fragile because the message includes the feature directory name, which may contain the same substrings. Set the discriminator at creation time and switch on it in the fix loop.

**Reproduced in:** `speckit-audit.ts` approval auto-fix (commit `4101e4d`): `finding.artifact === "spec"` replaced `finding.message.includes("spec")`.

**Test pattern:** Create a feature whose name contains a phase word (e.g., "tasks view" → `001-tasks-view`), set only `spec.md`, unmark approvals, run `--fix`, and assert that only `approvals.spec.generated` flips to `true` while `approvals.tasks.generated` stays `false`.

### Multi-value matrix tests for new code

A single happy-path `it()` proves almost nothing. Every pure function and every behavioral rule gets an `it.each` table that varies the values: boundary (empty, single char, max length), invalid (null, wrong type, missing field), unicode (CJK, emoji, null byte), structural (nested, empty arrays, bad element) and platform (Windows separators and casing). Encode the behavior the code **actually** has — verify against the implementation before writing the expectation, and when reality differs from the assumption, decide which is correct and comment the reason.

**Test pattern:** `tools/test/unit/matrix-types.test.ts` (parsers, phase detection, path safety, package manager), `matrix-io.test.ts` (BOM, checksums, backup keys, errno matchers), `matrix-guard.test.ts` (path matchers, phase protection, redirect extraction) and `integration/matrix-snapshot.test.ts` (trigger slug, timestamp format, id collisions, prune priority).

**Invariants that bite:** snapshot ids use **local** time (not UTC) and Zod schemas legitimately accept unicode strings, empty arrays and empty labels — assert the real boundary. See `docs/testing.md` for the full inventory and conventions.

