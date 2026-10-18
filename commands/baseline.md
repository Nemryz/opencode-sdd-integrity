---
description: Add up the stored mutation reports and report the score per batch and combined
---

Read the mutation results of this kit with the `speckit-mutation` tool, which owns the workflow described in `docs/testing.md`.

## Task

1. Call `speckit-mutation` with subcommand `aggregate`
2. Report the per batch rows and the combined row exactly as the tool prints them
3. Name the batches that are still pending, because a combined row over a subset of the batches is not the score of the kit

## Rules

- Never recompute, average, or estimate a score, because the tool prints the number Stryker itself computes
- Never present the combined row as a per file figure, because the denominator follows the batch boundary in `mutation-batches.json`
- State that static mutants are ignored in the current configuration whenever a score is reported, since the score would be lower with them measured
- If the tool answers `Nothing to aggregate`, point the user at `/matrix` instead of reporting an empty score
- When the combined score sits below `thresholds.low` in `stryker.conf.json`, say so plainly and name the batches with the most survivors, because that is where the work is

## Recording a baseline

Recording the numbers as the official baseline is a separate, deliberate step, because a figure written into `reports/mutation-testing-analysis.md` becomes the reference everyone compares against.

When the user asks to record the baseline, write every batch row, the combined row, the date, and the configuration that produced them, including that static mutants were ignored.
Never record a baseline from a subset of the batches without saying so in the document.
