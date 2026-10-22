import { describe, it, expect } from "vitest"
import { detectEvent } from "../../plugins/speckit-events"

describe("detectEvent", () => {
  it("detects sdd.phase.changed from speckit-phase result", () => {
    const result = "Phase: spec -> plan"
    const event = detectEvent("speckit-phase", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.phase.changed")
    expect(event!.timestamp).toBeTruthy()
  })

  it("detects phase change with arrow format", () => {
    const result = "phase: tasks->ready"
    const event = detectEvent("speckit-phase", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.phase.changed")
    expect(event!.from).toBe("tasks")
    expect(event!.to).toBe("ready")
  })

  it("detects sdd.approved from speckit-approve result", () => {
    const result = "spec approved. Next: /plan"
    const event = detectEvent("speckit-approve", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.approved")
  })

  it("detects approval with artifact name", () => {
    const result = "plan approved. Next: /tasks"
    const event = detectEvent("speckit-approve", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.approved")
    expect(event!.artifact).toBe("plan")
  })

  it("detects sdd.task.completed from speckit-evidence result", () => {
    const result = "Evidence recorded for T-001"
    const event = detectEvent("speckit-evidence", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.task.completed")
  })

  it("detects sdd.archived from speckit-archive result", () => {
    const result = "Feature 001-demo archived to archive/2026-10-20-001-demo"
    const event = detectEvent("speckit-archive", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.archived")
    expect(event!.archivePath).toBe("archive/2026-10-20-001-demo")
  })

  it("returns null for unknown tool", () => {
    const event = detectEvent("speckit-status", "Phase: spec")
    expect(event).toBeNull()
  })

  it("returns null for null result", () => {
    const event = detectEvent("speckit-phase", null)
    expect(event).toBeNull()
  })

  it("returns null for undefined result", () => {
    const event = detectEvent("speckit-phase", undefined)
    expect(event).toBeNull()
  })

  it("returns null for empty string", () => {
    const event = detectEvent("speckit-phase", "")
    // Empty string doesn't contain "phase" so returns null
    expect(event).toBeNull()
  })

  it("handles object result", () => {
    const result = { output: "spec approved" }
    const event = detectEvent("speckit-approve", result)
    expect(event).not.toBeNull()
    expect(event!.event).toBe("sdd.approved")
  })

  it("handles result with error", () => {
    const result = "Error: something went wrong"
    const event = detectEvent("speckit-phase", result)
    expect(event).toBeNull()
  })

  it("timestamp is valid ISO-8601", () => {
    const result = "phase: spec -> plan"
    const event = detectEvent("speckit-phase", result)
    expect(event).not.toBeNull()
    const date = new Date(event!.timestamp)
    expect(date.getTime()).not.toBeNaN()
  })

  it("feature defaults to null", () => {
    const result = "phase: spec -> plan"
    const event = detectEvent("speckit-phase", result)
    expect(event).not.toBeNull()
    expect(event!.feature).toBeNull()
  })
})

describe("detectEvent survivor killers", () => {
  // Tool-name guards: a non-SDD tool name must never be routed into a branch.
  it("does not treat speckit-status as a phase change even with phase-shaped output", () => {
    expect(detectEvent("speckit-status", "phase: spec -> plan")).toBeNull()
  })
  it("does not treat speckit-status as an approval even with approval-shaped output", () => {
    expect(detectEvent("speckit-status", "spec approved")).toBeNull()
  })
  it("does not treat speckit-status as evidence even with evidence-shaped output", () => {
    expect(detectEvent("speckit-status", "record")).toBeNull()
  })
  it("does not treat speckit-status as an archive even with archive-shaped output", () => {
    expect(detectEvent("speckit-status", "Archived")).toBeNull()
  })

  // Fallback branches need a result that misses the primary regex.
  it("falls back to a bare phase event when the arrow is missing", () => {
    const ev = detectEvent("speckit-phase", "phase only, no arrow")
    expect(ev).not.toBeNull()
    expect(ev!.event).toBe("sdd.phase.changed")
    expect(ev!.from).toBeUndefined()
  })
  it("falls back to a bare approval event when the artifact name is missing", () => {
    const ev = detectEvent("speckit-approve", "approved without artifact name")
    expect(ev).not.toBeNull()
    expect(ev!.event).toBe("sdd.approved")
    expect(ev!.artifact).toBeUndefined()
  })

  // String triggers: empty-string inputs must not fire a branch.
  it("does not fire evidence on a result with no record or evidence token", () => {
    expect(detectEvent("speckit-evidence", "nothing here")).toBeNull()
  })
  it("does not fire archive on a result with no Archived token", () => {
    expect(detectEvent("speckit-archive", "nothing here")).toBeNull()
  })
  it("returns null archivePath when there is no 'archived to' path", () => {
    const ev = detectEvent("speckit-archive", "Archived without a path")
    expect(ev).not.toBeNull()
    expect(ev!.archivePath).toBeNull()
  })

  it("does not fire approval on a result with no approved token", () => {
    expect(detectEvent("speckit-approve", "nothing here")).toBeNull()
  })
})
