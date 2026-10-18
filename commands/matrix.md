---
description: Measure every mutation batch of this kit and store one report per batch
---

Measure the kit with the `speckit-mutation` tool, which owns the mutation workflow described in `docs/testing.md`.

## Task

1. Map `$ARGUMENTS` to the tool call:
   - empty or `list` → subcommand `list`: every batch with its file count and whether it was already measured
   - `<batch> [batch...]` → subcommand `run <batch> [batch...]`: measure those batches and store one report each
   - `all` → call `list` first, then call `run` with every batch id it reports, in that order
2. Call `speckit-mutation` with the mapped subcommand
3. Report the result as it comes, naming each batch and how long the slow ones took

## Rules

- The batches run one after another, never in parallel, because every Stryker run starts the whole suite in its dry run and running several at once only makes each one slower
- A batch that fails stops the sequence and its output is reported verbatim, because a partial matrix is not a matrix
- This command only runs inside a checkout of the kit, so if the tool answers `Not a kit checkout`, say that instead of retrying
- A single batch takes minutes rather than seconds, so warn the user before starting `all` on ten batches
- Never claim a batch was measured when the tool reported a failure for it
