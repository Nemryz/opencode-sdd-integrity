---
description: Measure every mutation batch of this kit and store one report per batch
---

Measure the kit with the `speckit-mutation` tool, which owns the mutation workflow described in `docs/testing.md`.

## Task

1. Map `$ARGUMENTS` to the tool call:
   - empty or `list` → subcommand `list`: every batch with its file count and whether it was already measured
   - `<batch>` → subcommand `run <batch>`: measure that batch and store its report
   - `all` → call `list` first, then call `run` once per batch id it reports, one batch per tool call, in that order
2. Call `speckit-mutation` with the mapped subcommand
3. Report after each batch, naming it and saying how long it took, so a long run still shows progress

## Rules

- One batch per tool call, never several in one call, because a call that measures several batches blocks for as long as their sum and a single batch already takes minutes
- The batches run one after another, never in parallel, because every Stryker run starts the whole suite in its dry run and running several at once only makes each one slower
- A batch that fails stops the sequence and its output is reported verbatim, because a partial matrix is not a matrix
- Before starting `all`, tell the user that every batch takes minutes rather than seconds, because thirteen of them add up to hours on a laptop
- If a call for a batch returns nothing because it timed out, check `list` before retrying, because the report may already be stored
- This command only runs inside a checkout of the kit, so if the tool answers `Not a kit checkout`, say that instead of retrying
- A single batch takes minutes rather than seconds, so warn the user before starting `all` on thirteen batches
- Never claim a batch was measured when the tool reported a failure for it
