import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  emitEvent,
  readEvents,
  detectEvent,
} from "../../plugins/speckit-events"
import { mockContext, destroyTempWorktree } from "../helpers/setup"

let worktree: string

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-events-"))
})

afterEach(async () => {
  await destroyTempWorktree(worktree)
})

describe("speckit-events integration (real filesystem)", () => {
  const ctx = mockContext(worktree)

  it("appends and reads events.jsonl", async () => {
    await emitEvent(worktree, { event: "sdd.phase.changed", feature: null, timestamp: new Date().toISOString(), from: "spec", to: "plan" })
    await emitEvent(worktree, { event: "sdd.approved", feature: "001-demo", timestamp: new Date().toISOString(), artifact: "spec" })

    const events = await readEvents(worktree)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("sdd.phase.changed")
    expect(events[0].feature).toBeNull()
    expect(events[1].event).toBe("sdd.approved")
    expect(events[1].feature).toBe("001-demo")
  })

  it("limits the number of returned events", async () => {
    const base = new Date().toISOString()
    for (let i = 0; i < 5; i++) {
      await emitEvent(worktree, { event: "sdd.task.completed", feature: null, timestamp: base, idx: i })
    }

    const lastTwo = await readEvents(worktree, 2)
    expect(lastTwo).toHaveLength(2)
    expect(lastTwo[0].idx).toBe(3)
    expect(lastTwo[1].idx).toBe(4)
  })

  it("returns empty array when events.jsonl does not exist", async () => {
    const events = await readEvents(worktree)
    expect(events).toEqual([])
  })

  it("returns empty array when events.jsonl contains invalid JSON", async () => {
    const logDir = path.join(worktree, ".opencode", "spec-memory")
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, "events.jsonl"), "not valid json\n{broken", "utf-8")

    const events = await readEvents(worktree)
    expect(events).toEqual([])
  })

  describe("detectEvent", () => {
    it("detects a phase change from speckit-phase", async () => {
      const ev = detectEvent("speckit-phase", { output: "phase: spec -> plan" })
      expect(ev).not.toBeNull()
      expect(ev?.event).toBe("sdd.phase.changed")
      expect(ev?.from).toBe("spec")
      expect(ev?.to).toBe("plan")
    })

    it("detects an approval from speckit-approve", async () => {
      const ev = detectEvent("speckit-approve", { output: "spec approved" })
      expect(ev).not.toBeNull()
      expect(ev?.event).toBe("sdd.approved")
      expect(ev?.artifact).toBe("spec")
    })

    it("detects archive from speckit-archive", async () => {
      const ev = detectEvent("speckit-archive", "Feature archived to archive/2024-01-01-001-demo")
      expect(ev).not.toBeNull()
      expect(ev?.event).toBe("sdd.archived")
      expect(ev?.archivePath).toBe("archive/2024-01-01-001-demo")
    })

    it("returns null for unknown tool", async () => {
      const ev = detectEvent("speckit-unknown", { output: "something" })
      expect(ev).toBeNull()
    })
  })
})
