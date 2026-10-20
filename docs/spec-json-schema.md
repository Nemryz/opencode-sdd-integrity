# spec.json — Phase Tracking Schema

Each feature directory contains a `spec.json` that serves as the source of truth for
phase state and artifact approvals. Tools and skills read/write this file to track
progress programmatically.

## Schema

```json
{
  "feature_name": "<kebab-case-feature-name>",
  "feature_number": <NNN>,
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "phase": "spec" | "plan" | "tasks" | "ready" | "impl" | "complete",
  "approvals": {
    "spec":  { "generated": false, "approved": false },
    "plan":  { "generated": false, "approved": false },
    "tasks": { "generated": false, "approved": false }
  },
  "ready_for_implementation": false,
  "converged": false,
  "convergenceHistory": []
}
```

## Phase Values

| Phase | Meaning |
|-------|---------|
| `spec` | spec.md exists and is being worked on |
| `plan` | spec.md approved, plan.md exists |
| `tasks` | plan.md approved, tasks.md exists |
| `ready` | all artifacts complete, ready for /impl |
| `impl` | implementation in progress |
| `complete` | implementation finished |

## Approval Rules

- `generated`: set to `true` when a skill finishes writing the artifact
- `approved`: set to `true` when the user confirms the artifact
- `ready_for_implementation`: derived — `true` when all `generated` and `approved` are `true`
- `converged`: `true` when `/converge` reports all acceptance criteria met (optional, defaults to `false`)
- `convergenceHistory`: array of `{ date, status, gaps }` recording each `/converge` run (optional, defaults to `[]`)

## Update Rules

- Skills set `generated = true` after writing an artifact
- Skills set `phase` to the next phase after completing their work
- `updated_at` is set to the current UTC timestamp on every write
- Tools read `spec.json` as the primary phase source; fall back to file detection if missing
