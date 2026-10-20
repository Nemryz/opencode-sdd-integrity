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