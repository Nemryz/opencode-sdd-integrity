import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { emitEvent, readEvents } from "../../plugins/speckit-events"
import { removeDirWithRetry } from "../helpers/setup"

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-event-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeDirWithRetry(dir)))
})

describe("emitEvent", () => {
  it("creates events.jsonl if it doesn't exist", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: "2026-10-20T00:00:00Z", from: "spec", to: "plan" })
    const events = await readEvents(root)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("sdd.phase.changed")
  })

  it("appends to existing events.jsonl", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: "2026-10-20T00:00:00Z" })
    await emitEvent(root, { event: "sdd.approved", feature: "001-demo", timestamp: "2026-10-20T00:01:00Z" })
    const events = await readEvents(root)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("sdd.phase.changed")
    expect(events[1].event).toBe("sdd.approved")
  })

  it("creates spec-memory directory if it doesn't exist", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: null, timestamp: "2026-10-20T00:00:00Z" })
    const exists = await fs.access(path.join(root, ".opencode", "spec-memory", "events.jsonl")).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it("writes one JSON line per event", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: "2026-10-20T00:00:00Z" })
    const raw = await fs.readFile(path.join(root, ".opencode", "spec-memory", "events.jsonl"), "utf-8")
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })
})

describe("readEvents", () => {
  it("returns empty array when file doesn't exist", async () => {
    const root = await makeTempDir()
    const events = await readEvents(root)
    expect(events).toEqual([])
  })

  it("returns all events when no limit", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: "2026-10-20T00:00:00Z" })
    await emitEvent(root, { event: "sdd.approved", feature: "001-demo", timestamp: "2026-10-20T00:01:00Z" })
    await emitEvent(root, { event: "sdd.task.completed", feature: "001-demo", timestamp: "2026-10-20T00:02:00Z" })
    const events = await readEvents(root)
    expect(events).toHaveLength(3)
  })

  it("returns last N events when limit is set", async () => {
    const root = await makeTempDir()
    await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: "2026-10-20T00:00:00Z" })
    await emitEvent(root, { event: "sdd.approved", feature: "001-demo", timestamp: "2026-10-20T00:01:00Z" })
    await emitEvent(root, { event: "sdd.task.completed", feature: "001-demo", timestamp: "2026-10-20T00:02:00Z" })
    const events = await readEvents(root, 2)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("sdd.approved")
    expect(events[1].event).toBe("sdd.task.completed")
  })

  it("returns empty array when file is corrupt", async () => {
    const root = await makeTempDir()
    const logPath = path.join(root, ".opencode", "spec-memory", "events.jsonl")
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(logPath, "not valid json\n{broken", "utf-8")
    const events = await readEvents(root)
    expect(events).toEqual([])
  })

  it("preserves event order", async () => {
    const root = await makeTempDir()
    for (let i = 0; i < 5; i++) {
      await emitEvent(root, { event: "sdd.phase.changed", feature: "001-demo", timestamp: `2026-10-20T00:0${i}:00Z` })
    }
    const events = await readEvents(root)
    expect(events).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(events[i].timestamp).toBe(`2026-10-20T00:0${i}:00Z`)
    }
  })
})