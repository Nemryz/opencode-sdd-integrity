import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { markPluginLoaded } from "../shared/io"
import { pickProjectRoot } from "../shared/types"

export type DoomLoopOptions = {
  enabled: boolean
  warnAt: number
  blockAt: number
  resetAfterMs: number
  maxEntries: number
}

export const DEFAULT_DOOM_LOOP_OPTIONS: DoomLoopOptions = {
  enabled: true,
  warnAt: 3,
  blockAt: 5,
  resetAfterMs: 10 * 60 * 1000,
  maxEntries: 256,
}

const MAX_FINGERPRINT_LENGTH = 4096
const MAX_SERIALIZE_DEPTH = 12

// Merges the plugin options with the defaults and repairs values that would leave the detector unusable.
export function parseDoomLoopOptions(raw: unknown): DoomLoopOptions {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const readCount = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
  const readPositive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

  const warnAt = readCount(source.warnAt, DEFAULT_DOOM_LOOP_OPTIONS.warnAt)
  return {
    enabled: source.enabled === false ? false : true,
    warnAt,
    // A block threshold at or below the warning threshold would hide the warning from the model.
    blockAt: Math.max(readCount(source.blockAt, DEFAULT_DOOM_LOOP_OPTIONS.blockAt), warnAt + 1),
    resetAfterMs: readPositive(source.resetAfterMs, DEFAULT_DOOM_LOOP_OPTIONS.resetAfterMs),
    maxEntries: readCount(source.maxEntries, DEFAULT_DOOM_LOOP_OPTIONS.maxEntries),
  }
}

// Rewrites a value with sorted object keys and cycle placeholders so serialization stays deterministic.
function normalizeForFingerprint(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_SERIALIZE_DEPTH) return "[too deep]"
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForFingerprint(item, seen, depth + 1))
  }
  if (value && typeof value === "object") {
    if (seen.has(value as object)) return "[circular]"
    seen.add(value as object)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalizeForFingerprint((value as Record<string, unknown>)[key], seen, depth + 1)
    }
    return result
  }
  return value
}

// Builds the session key for one tool call so that argument order never masks a repeated call.
export function fingerprintCall(tool: string, input: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(normalizeForFingerprint(input, new WeakSet(), 0)) ?? String(input)
  } catch {
    serialized = String(input)
  }
  return `${tool}:${serialized.slice(0, MAX_FINGERPRINT_LENGTH)}`
}

// Recognizes the failure signals the runtime and the kit tools store in a finished result.
function metadataSignalsFailure(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  const meta = metadata as Record<string, unknown>
  if (meta.error !== undefined) return true
  if (meta.title === "Error") return true
  return typeof meta.exit === "number" && meta.exit !== 0
}

// Reads the V2 hook event, where the runtime reports transport failures on the event itself.
export function isV2Failure(event: unknown): boolean {
  const value = event as { status?: string; result?: { metadata?: unknown } } | undefined
  if (value?.status === "error") return true
  return metadataSignalsFailure(value?.result?.metadata)
}

// Reads the V1 hook output, which exposes only the finished title, output and metadata.
export function isV1Failure(output: unknown): boolean {
  const value = output as { metadata?: unknown } | undefined
  return metadataSignalsFailure(value?.metadata)
}

// Builds the warning that reaches the model before it repeats the same call again.
export function warningMessage(tool: string, failures: number, blockAt: number): string {
  return [
    `Doom loop warning from the speckit plugin. The same "${tool}" call has now failed ${failures} times with identical input.`,
    `Do not retry it unchanged. Inspect the last error, change the command or the approach, or ask the user how to proceed.`,
    `The call will be blocked after ${blockAt} identical failures.`,
  ].join(" ")
}

// Builds the error that replaces the next identical call once the block threshold is reached.
export function blockMessage(tool: string, failures: number): string {
  return `Doom loop blocked. The same "${tool}" call already failed ${failures} times with identical input, so repeating it will not help. Change the command or the approach, or ask the user how to proceed.`
}

type LoopEntry = {
  failures: number
  warned: boolean
  blocked: boolean
  lastFailureAt: number
}

export type LoopDecision = { kind: "allow" } | { kind: "block"; message: string }

// Counts identical failing calls per session and turns the counts into a warning and then into a block.
export class DoomLoopTracker {
  private readonly sessions = new Map<string, Map<string, LoopEntry>>()

  constructor(
    private readonly options: DoomLoopOptions,
    private readonly now: () => number = Date.now,
  ) {}

  // Records one call outcome and reports whether the warning threshold was crossed for the first time.
  record(sessionID: string, fingerprint: string, failed: boolean): { warn: boolean; failures: number } {
    const bucket = this.bucket(sessionID)
    if (!failed) {
      bucket.delete(fingerprint)
      this.shrink(sessionID, bucket)
      return { warn: false, failures: 0 }
    }

    const entry = bucket.get(fingerprint) ?? { failures: 0, warned: false, blocked: false, lastFailureAt: 0 }
    entry.failures++
    entry.lastFailureAt = this.now()
    entry.blocked = entry.blocked || entry.failures >= this.options.blockAt
    const warn = !entry.warned && entry.failures >= this.options.warnAt
    entry.warned = entry.warned || warn
    bucket.set(fingerprint, entry)
    this.prune(bucket)
    return { warn, failures: entry.failures }
  }

  // Decides whether one call must be blocked before it repeats an identical failure streak.
  inspect(sessionID: string, fingerprint: string, tool: string): LoopDecision {
    const bucket = this.sessions.get(sessionID)
    if (!bucket) return { kind: "allow" }
    const entry = bucket.get(fingerprint)
    if (!entry) return { kind: "allow" }
    if (this.now() - entry.lastFailureAt > this.options.resetAfterMs) {
      bucket.delete(fingerprint)
      this.shrink(sessionID, bucket)
      return { kind: "allow" }
    }
    if (!entry.blocked) return { kind: "allow" }
    return { kind: "block", message: blockMessage(tool, entry.failures) }
  }

  private bucket(sessionID: string): Map<string, LoopEntry> {
    let bucket = this.sessions.get(sessionID)
    if (!bucket) {
      bucket = new Map()
      this.sessions.set(sessionID, bucket)
    }
    return bucket
  }

  // Drops expired streaks and caps the bucket so a long session cannot grow without bound.
  private prune(bucket: Map<string, LoopEntry>): void {
    const cutoff = this.now() - this.options.resetAfterMs
    for (const [key, entry] of bucket) {
      if (entry.lastFailureAt < cutoff) bucket.delete(key)
    }
    while (bucket.size > this.options.maxEntries) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [key, entry] of bucket) {
        if (entry.lastFailureAt < oldestAt) {
          oldestAt = entry.lastFailureAt
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      bucket.delete(oldestKey)
    }
  }

  // Removes the session bucket once its last streak disappears.
  private shrink(sessionID: string, bucket: Map<string, LoopEntry>): void {
    if (bucket.size === 0) this.sessions.delete(sessionID)
  }
}

// Reads the tracker without letting a detector bug break the tool call it is inspecting.
function safeInspect(tracker: DoomLoopTracker, sessionID: string, tool: string, input: unknown): LoopDecision {
  try {
    return tracker.inspect(sessionID, fingerprintCall(tool, input), tool)
  } catch {
    return { kind: "allow" }
  }
}

const doomLoopServer: V1Plugin = async (input, options) => {
  const projectRoot = pickProjectRoot(input) ?? input.worktree
  await markPluginLoaded(projectRoot, "speckit-doom-loop")

  const parsed = parseDoomLoopOptions(options)
  if (!parsed.enabled) return {}
  const tracker = new DoomLoopTracker(parsed)
  const pendingWarnings = new Map<string, string[]>()

  return {
    "tool.execute.before": async (toolInput, toolOutput) => {
      const decision = safeInspect(tracker, toolInput.sessionID, toolInput.tool, toolOutput?.args)
      if (decision.kind === "block") throw new Error(decision.message)
    },

    "tool.execute.after": async (toolInput, toolOutput) => {
      try {
        const outcome = tracker.record(toolInput.sessionID, fingerprintCall(toolInput.tool, toolInput.args), isV1Failure(toolOutput))
        if (outcome.warn) {
          const list = pendingWarnings.get(toolInput.sessionID) ?? []
          list.push(warningMessage(toolInput.tool, outcome.failures, parsed.blockAt))
          pendingWarnings.set(toolInput.sessionID, list)
        }
      } catch {
        // detection is diagnostic only, a failing hook must never disturb the tool flow
      }
    },

    // Delivers queued warnings through the system prompt because the V1 runtime offers no synthetic message.
    "experimental.chat.system.transform": async (hookInput, output) => {
      const sessionID = hookInput?.sessionID
      if (!sessionID) return
      const list = pendingWarnings.get(sessionID)
      if (!list || list.length === 0) return
      for (const text of list) output.system.push(text)
      pendingWarnings.delete(sessionID)
    },
  }
}

export default {
  id: "speckit-doom-loop",
  async setup(ctx: V2Plugin.Context): Promise<void> {
    const projectRoot = ctx.location.project.canonical
    await markPluginLoaded(projectRoot, "speckit-doom-loop")

    const options = parseDoomLoopOptions(ctx.options)
    if (!options.enabled) return
    const tracker = new DoomLoopTracker(options)

    await ctx.tool.hook("execute.before", async (event) => {
      const decision = safeInspect(tracker, event.sessionID, event.tool, event.input)
      if (decision.kind === "block") throw new Error(decision.message)
    })

    await ctx.tool.hook("execute.after", async (event) => {
      try {
        const outcome = tracker.record(event.sessionID, fingerprintCall(event.tool, event.input), isV2Failure(event))
        if (outcome.warn) {
          await ctx.session.synthetic({
            sessionID: event.sessionID,
            text: warningMessage(event.tool, outcome.failures, options.blockAt),
          })
        }
      } catch {
        // detection is diagnostic only, a failing hook must never disturb the tool flow
      }
    })
  },
  server: doomLoopServer,
}
