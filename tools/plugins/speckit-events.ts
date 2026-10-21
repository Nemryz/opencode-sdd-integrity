import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"

// Event types emitted by the SDD workflow
export type SddEventType =
  | "sdd.phase.changed"
  | "sdd.approved"
  | "sdd.task.completed"
  | "sdd.converged"
  | "sdd.archived"

export interface SddEvent {
  event: SddEventType
  feature: string | null
  timestamp: string
  [key: string]: unknown
}

// Appends an event to the events.jsonl log
export async function emitEvent(projectRoot: string, event: SddEvent): Promise<void> {
  const logPath = path.join(projectRoot, ".opencode", "spec-memory", "events.jsonl")
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const line = JSON.stringify(event) + "\n"
  await fs.appendFile(logPath, line, "utf-8")
}

// Reads the events log
export async function readEvents(projectRoot: string, limit?: number): Promise<SddEvent[]> {
  const logPath = path.join(projectRoot, ".opencode", "spec-memory", "events.jsonl")
  try {
    const data = await fs.readFile(logPath, "utf-8")
    const lines = data.trim().split(/\r?\n/).filter(Boolean)
    const events = lines.map((line) => JSON.parse(line) as SddEvent)
    if (limit && limit > 0) {
      return events.slice(-limit)
    }
    return events
  } catch {
    return []
  }
}

// Detects SDD events from tool execution results
export function detectEvent(toolName: string, result: unknown): SddEvent | null {
  const now = new Date().toISOString()
  const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? {})

  if (toolName === "speckit-phase") {
    const match = resultStr.match(/phase[:\s]+(\w+)\s*->\s*(\w+)/i)
    if (match) {
      return { event: "sdd.phase.changed", feature: null, timestamp: now, from: match[1], to: match[2] }
    }
    // Fallback: try to parse from output
    if (resultStr.includes("phase")) {
      return { event: "sdd.phase.changed", feature: null, timestamp: now }
    }
  }

  if (toolName === "speckit-approve") {
    const match = resultStr.match(/(\w+)\s+approved/i)
    if (match) {
      return { event: "sdd.approved", feature: null, timestamp: now, artifact: match[1] }
    }
    if (resultStr.includes("approved")) {
      return { event: "sdd.approved", feature: null, timestamp: now }
    }
  }

  if (toolName === "speckit-evidence") {
    if (resultStr.includes("record") || resultStr.includes("evidence")) {
      return { event: "sdd.task.completed", feature: null, timestamp: now }
    }
  }

  if (toolName === "speckit-archive") {
    if (resultStr.includes("Archived") || resultStr.includes("archived")) {
      const pathMatch = resultStr.match(/archived to (.+)/i)
      return { event: "sdd.archived", feature: null, timestamp: now, archivePath: pathMatch ? pathMatch[1] : null }
    }
  }

  return null
}

export default {
  id: "speckit-events",
  async setup(ctx: any): Promise<void> {
    const projectRoot = ctx.location.project.canonical

    await ctx.tool.hook("execute.after", async (toolName: string, result: unknown) => {
      const event = detectEvent(toolName, result)
      if (event) {
        // Try to extract feature from context
        try {
          const sessionPath = path.join(projectRoot, ".opencode", "spec-memory", "session.json")
          const sessionData = await fs.readFile(sessionPath, "utf-8")
          const session = JSON.parse(sessionData)
          if (session.featureDir) {
            event.feature = session.featureDir
          }
        } catch {
          // No session, leave feature null
        }
        await emitEvent(projectRoot, event)
      }
    })
  },
}