# State Transactions

How the kit builds an immutable state plan, applies it with a journal, and recovers an interrupted archive.
The design borrows mechanisms that are already proven in other systems, while the implementation stays inside the kit and adds no runtime dependency.

## Why this layer exists

The archive tool used to create the destination directory and then move one entry at a time.
A failure in the middle of that loop left one feature split between `specs/` and `archive/`, with no record of what had already moved.
The same gap applied to the session update that follows the move, because the session write was a second independent operation.

A state transaction closes the gap with three guarantees.

- The caller describes the whole change in an immutable plan before anything is written.
- The plan carries the state hash it was built on and the hash the state must have when the transaction finishes.
- Every write happens behind a journal, so a crash can be rolled forward or rolled back on the next run.

## Prior art

| Source | License | Mechanism borrowed | Mechanism rejected |
|---|---|---|---|
| Terraform saved plan and stale plan check | BUSL 1.1, concept only | The plan records the state identity it was built on, and apply refuses a plan that no longer matches | HCL, provider plugins, remote state and serial counters |
| SQLite rollback journal | Public domain | Original state is written before mutation, the commit clears the journal, and recovery runs on startup | Page level WAL, checkpoints and shared memory coordination |
| `write-file-atomic` | ISC, concept only | A unique sibling temp file, `fsync`, rename and transient Windows retries | Adding the package as a dependency |
| `proper-lockfile` | MIT, concept only | An ownership token, stale detection, retries and visible compromised state | Network filesystem support and heartbeat timers |
| Linux `renameat2(RENAME_NOREPLACE)` | Kernel API | A rename that never clobbers an existing destination | A native addon or a non portable syscall binding |
| Git index lock | GPL-2.0, concept only | An exclusive lock and an atomic rename as the commit point | The lock file format and index internals |

No source code is copied from those projects.
The only direct reuse is the public idea of a plan that refuses to apply against a changed state, a rollback journal and an atomic rename.
If a small snippet is ever adapted, the source, license and attribution must sit beside it.

## The plan contract

A state plan is a frozen value with these fields.

```ts
type StatePrecondition = {
  path: string
  kind: "file" | "dir" | "absent"
  sha256?: string
}

type StateOperation =
  | { kind: "rename-dir"; from: string; to: string }
  | { kind: "write-spec-json"; featureDir: string; data: SpecJson }
  | { kind: "write-session"; data: SessionState }
  | { kind: "write-config"; data: SDDConfig }

type StatePlan = {
  format: 1
  planId: string
  createdAt: string
  scope: string[]
  preconditions: StatePrecondition[]
  operations: StateOperation[]
  baseHash: string
  expectedHash: string
  planHash: string
}
```

The three hashes answer three different questions.

- `planHash` proves the plan itself was not edited after it was built.
- `baseHash` proves the state the plan was built on is still the current state.
- `expectedHash` proves the apply produced the exact state the planner predicted.

The hash covers the plan scope, not the whole repository.
A change in an unrelated feature does not invalidate the plan, while a change in the source feature, the target path or the session file does.

Paths inside a plan are project relative and must stay inside the project root.
Absolute paths, drive letters, empty segments, traversal segments and symlinked parents that escape the root are rejected before the plan is built.

## Building a plan

`createStatePlan` reads the current scope hash, verifies every precondition and simulates the operations against an in memory path map.
The simulation uses the same pure preparation helpers as the writers, so the planned bytes and the written bytes are identical.

The planner never writes.
That separation is what makes a future preview or dry run command possible without changing the apply protocol.

## Applying a plan

`applyStatePlan` runs these steps in order.

1. Validate the plan schema and recompute `planHash`.
2. Acquire the global state lock.
3. Recover any transaction that a previous process left behind.
4. Recompute `baseHash` and recheck every precondition.
5. Create the transaction directory and back up every file that will be replaced.
6. Write the journal in the `prepared` state and fsync it.
7. Move the journal to `applying` and execute the operations.
8. Recompute the scope hash and compare it with `expectedHash`.
9. Mark the journal `committed`, remove the transaction directory and run auto versioning.
10. On failure, mark the journal `rolling-back`, restore the backups and reverse the directory renames.

A `rename-dir` operation is one `fs.rename`.
The archive never copies a feature file by file.
A rename that crosses devices fails with `EXDEV` before the metadata changes, and the archive reports that the archive directory must stay on the same file system.

A conflict returns `STALE_BASE`, `PRECONDITION` or `TARGET_EXISTS` and leaves the state untouched.
A verification failure rolls back and reports the journal path.
A failed rollback keeps the journal and blocks later applies until the repair succeeds.

Normal writers take the global state lock before their own file lock, so two read-modify-write tools cannot interleave session, spec or config changes.
Callers that already hold a per-file lock must take the global lock outside it; every tool in the kit follows that order.
Apply holds the global lock for the whole transaction and writes its targets directly, because it already owns the exclusive state boundary.

## The journal

The journal lives under the project state directory.

```text
.opencode/transactions/<txId>/journal.json
.opencode/transactions/<txId>/backups/<relative-path>
```

The journal records the plan identity, the base and expected hashes, the operations, the backups and one of these states.

- `prepared`: the transaction dir and backups exist, but no operation ran.
- `applying`: at least one operation may have run.
- `committed`: every operation and the final hash check succeeded.
- `rolling-back`: a failure is being undone.
- `rollback-failed`: the undo itself failed and a human must inspect the journal.

Recovery is idempotent.
A committed journal only needs cleanup, a prepared or applying journal is rolled back, and a rollback failed journal is reported instead of hidden.
The oldest journal is recovered first so a chain of interrupted runs cannot reorder the state.
`/archive` recovers before it plans, `/health --fix` recovers and names the transaction ids it cleared, and `/health` and `/status` list pending transactions without modifying them.

The transaction directory is excluded from snapshots and from the plan hash.
It is transient machinery, not user state.

## The archive case

The archive plan moves the whole feature directory with one rename, then writes `archived_at` into the archived `spec.json` and clears the active session when it points at that feature.

The plan carries three preconditions.

- The source feature directory exists and has the expected tree hash.
- The archive target does not exist.
- The session file, when it references the feature, has the expected content hash.

The collision suffix is chosen before the plan is built.
If the target appears before apply, the tool rebuilds once with the next suffix and then reports a conflict rather than choosing a different name silently.
Rollback treats a directory rename as atomic: when the source still exists, the rename never completed, so a target created by another actor is left intact instead of being mistaken for the archived feature.

The pre archive snapshot stays in place.
The snapshot is the user facing recovery point, while the transaction journal is the undo log for the operation itself.

## Limits

- The transaction protects state paths inside one project root.
- It does not replace a snapshot, because a transaction only covers the operations it planned.
- It does not copy across file systems, because a copy and delete sequence is not atomic.
- It rejects symbolic links inside a planned tree, because a link can point outside the project root.
- It does not provide a native no clobber rename on every platform. Node has no portable `RENAME_NOREPLACE`, so the lock and the absent target precondition close the race inside this process.
- It does not sandbox code. The lab remains an isolation boundary for paths, not a security boundary.

## References

- Terraform plan command: https://developer.hashicorp.com/terraform/cli/commands/plan
- Terraform stale plan explanation: https://discuss.hashicorp.com/t/question-on-error-saved-plan-is-stale/52912
- SQLite atomic commit: https://sqlite.org/atomiccommit.html
- write-file-atomic: https://github.com/npm/write-file-atomic
- proper-lockfile: https://github.com/moxystudio/node-proper-lockfile
- rename(2): https://man7.org/linux/man-pages/man2/rename.2.html
