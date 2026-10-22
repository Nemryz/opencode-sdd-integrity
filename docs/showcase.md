# Interface Quality Showcase

This document shows what a user and an agent actually see when they run this toolkit, and it compares that surface with the mainstream spec-driven kits.
Every toolkit output below was captured on 2026-10-19 by driving the shipped tools through their normal execute path against a throwaway project, so the strings are the ones the runtime returns rather than marketing copy.
The rival statements summarize their public documentation as recorded in `docs/positioning.md` on the same date, and adoption numbers are a dated photograph rather than a live feed.

The argument is narrow.
Process breadth belongs to the multi-harness kits, adoption belongs to them as well, and this document does not dispute either.
What it isolates is the interface layer, where the difference is not how many artifacts a workflow can produce but what happens when the model is about to do the wrong thing.

## The interface contract

The toolkit follows five rules, and the tools enforce them in code rather than asking the model to remember them.

1. Every error names the cause and the next command, so a blocked user has one obvious move.
2. Every report ends in a decision, not in a wall of state that the reader has to interpret.
3. Every state change asks first and spells out the impact, including what a restore will overwrite.
4. Every failure carries a typed category and metadata, so plugins, audits, and evidence can act on it.
5. The agent speaks in one to three lines, because detail belongs in files and files belong in the repository.

The first four rules live in the tool return values shown below.
The fifth rule lives in `AGENTS.md` as the Concise Output Rule, and the report tools are the deliberate exception because a severity table is the message.

## Gates that refuse instead of hoping

A gate that only exists in prose depends on the model reading it at the right moment.
These gates are branches in the tools, and the outputs below are the complete response a user receives.

Planning before the specification exists returns the state first and the next command last.

```
[Phase: empty] constitution missing | no features | Next: create constitution.md first
```

Implementation before tasks approval returns a directed error rather than a phase change.

```
[Error] Tasks are not approved for 001-showcase-demo. Run /approve tasks first.
```

Approval itself needs an explicit confirmation, and the tool asks for it instead of assuming intent.

```
[Confirm Approval] Approve spec for 001-showcase-demo? This records the approval and unlocks the next workflow phase. Ask the user to confirm, then re-run with confirmed: true.
```

The same pattern covers an artifact that changed after approval, a restore that would overwrite files, and a guard removal.
In every case the refusal is a tool result, so it survives a model that forgets the workflow, a session that was resumed hours later, and a user who asks for a shortcut.

Spec Kit, BMAD, and cc-sdd document the same approval moments as part of their command workflows.
Their published surfaces describe templates, hooks, agent personas, and skills without a documented runtime component that refuses an edit to protected state, and the difference shows up exactly when the agent ignores the documentation.
OpenSpec takes the opposite stance on purpose, with an explicit philosophy against rigid phase gates, which trades this kind of refusal for a lighter process.

## Reports that end in a decision

`/status` answers the only question that matters at the prompt, which is where the project stands and what to type next.

```
[Status: 1 feature(s)] Features: 1 | impl: 1  001-showcase-demo (impl)  Next: /impl (continue)
```

`/evidence` turns the test log into coverage, gaps, and the latest failing task without asking the reader to open a JSON file.

```
[Evidence: 001-showcase-demo] Evidence: 2/3 tasks covered (2 entries)
  missing: T-003
  failing latest: T-002 (npx vitest run, exit 1)
```

`/audit` groups findings by severity and category, and the new evidence checks appear next to the constitution and steering checks.

```
[Audit: 2 issue(s)] Audit: PASS | 0 error(s), 2 warning(s), 3 info
[WRN] constitution: Constitution file missing in .opencode/spec-memory/
[INF] steering: No steering directory (optional)
[INF] features: 1 feature(s) found: 001-showcase-demo
[WRN] evidence-failing: 001-showcase-demo: latest evidence for T-002 is a failing run (npx vitest run, exit 1)
[INF] evidence-gap: 001-showcase-demo: 1 task has no test evidence (T-003)
```

`/snapshot create` ends by naming the verification command that proves the snapshot is usable.

```
[Snapshot Created] 20261019-110122-manual
  files: 5 (1.3 KB)
  feature: 001-showcase-demo | phase: impl
Next: /snapshot drill 20261019-110122-manual to prove it can be restored
```

The multi-harness kits are stronger at the process artifacts around this layer, and the comparison should say so.
Spec Kit ships checklists and OpenSpec ships archiving and change proposals, both of which this toolkit does not have yet.
The difference here is not feature count but termination: each report above finishes with a command or a finding that can be acted on directly.

## Rails that explain themselves

The guard throws before an editor write or a shell redirect reaches a protected file, and the message names the rule that fired.

```
Guard blocked protected file: specs/001-showcase-demo/spec.json (Always protected: spec.json)
```

A redirect through the shell carries the same reason with the redirect target prefix.

```
Guard blocked protected file: specs/001-showcase-demo/spec.json (shell redirect target: Always protected: spec.json)
```

The doom-loop plugin warns before it blocks, and both messages explain what to change instead of only reporting a count.

```
Doom loop warning from the speckit plugin. The same "bash" call has now failed 3 times with identical input. Do not retry it unchanged. Inspect the last error, change the command or the approach, or ask the user how to proceed. The call will be blocked after 5 identical failures.
```

```
Doom loop blocked. The same "bash" call already failed 5 times with identical input, so repeating it will not help. Change the command or the approach, or ask the user how to proceed.
```

A restore asks with the impact already computed, and it promises the rollback before the user agrees.

```
[Confirm Restore] Restore 20261019-110122-manual? Impact: 0 changed, 0 created, 0 removed. A pre-restore safety snapshot is taken first and the restore rolls back on failure. Ask the user to confirm, then re-run with confirmed: true.
```

Corrupt evidence is refused rather than replaced, which keeps a bad write from erasing the history that explains it.

```
Evidence file specs/001-showcase-demo/evidence.json is corrupt or invalid. Refusing to overwrite it. Restore it from .opencode/backups or remove it manually.
```

OpenSpec's documented opposition to rigid gates means blocked states are not that kit's goal, and BMAD and cc-sdd place approvals in workflow documentation rather than in runtime checks.
Those are reasonable designs for human-driven sessions.
The rails above matter most when the actor about to touch state is a model, because the cost of an unexplained refusal is a retry loop and the cost of a silent write is a lost approval.

## What the rivals optimize instead

The table isolates the interface layer and leaves process breadth to `docs/positioning.md`.
An entry marked as not documented means the public documentation reviewed for that document does not describe the property, not that the property cannot exist.

| Kit | Interface surface | Enforcement | State and recovery |
|-----|-------------------|-------------|--------------------|
| OpenCode SDD Integrity (this repository) | 19 typed tools, 5 runtime plugins, 10 skills, 22 commands, structured results throughout | Approval gates, a file guard for editor and shell writes, pre-validation in the commands | Zod-validated state with atomic writes and checksums, backups, verified snapshots, restore drills and a crash-safe journal |
| Spec Kit | Templates, checklists, commands, and a generated TypeScript plugin that maps lifecycle events | Documentation, templates, and configurable hooks, without a documented edit guard | No documented resilient state layer |
| OpenSpec | Change proposals, commands, and a community sidebar plugin | An explicit philosophy against rigid phase gates | Markdown documents and commands, cross-repository stores in beta |
| BMAD | Agent personas and one command per skill | Documentation and workflows | Workflow documents, with Python and uv required for setup |
| cc-sdd | Skills for eight harnesses with steering context | Documentation and skills, autonomous implementation after approval | Steering context |

Distribution used to flip the comparison in the other direction, and the 2.0.0 release closes that half.
Every native competitor installs through npm with a wizard or a CLI, and this toolkit now ships an npm installer CLI next to the shell scripts, backed by the same surface contract the scripts verify.
Interface rigor is a reason to adopt today, and reach is the half of the distribution gap that stays open in `docs/positioning.md`, because a new package starts at zero downloads.

## Reproducing the gallery

The outputs come from the same code paths the runtime uses on OpenCode 2, where `tools/plugins/speckit-tools.ts` registers every tool.
The gates live in `tools/speckit-validate.ts`, `tools/speckit-approve.ts`, and `tools/speckit-phase.ts`, the reports in `tools/speckit-audit.ts`, `tools/speckit-status.ts`, and `tools/speckit-evidence.ts`, and the rails in `tools/plugins/speckit-guard.ts` and `tools/plugins/speckit-doom-loop.ts`.
The message strings come from the same code paths that the suite exercises, including the evidence findings added in `tools/test/integration/evidence.test.ts` and the doom-loop strings in `tools/test/integration/doom-loop.test.ts`.
