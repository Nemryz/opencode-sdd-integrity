import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { markPluginLoaded, stripBom } from "../shared/io"
import { pickProjectRoot } from "../shared/types"

type PerfStats = {
  tool: string
  calls: number
  totalTime: number
  times: number[]
  p50: number
  p95: number
  p99: number
  avg: number
}

type PerfData = {
  lastUpdated: string
  stats: PerfStats[]
}

const activeCalls: Map<string, { start: number; args: any }> = new Map()

function calculatePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0
  const index = Math.floor(sorted.length * percentile)
  return sorted[Math.min(index, sorted.length - 1)]
}

function generateRecommendations(stats: PerfStats[]): string[] {
  const recommendations: string[] = []
  for (const s of stats) {
    if (s.p99 > 2000) {
      recommendations.push(`  ⚠ ${s.tool}: Consider caching ${s.tool} results`)
    }
    if (s.p50 > 0 && s.p99 / s.p50 > 5) {
      recommendations.push(`  ⚠ ${s.tool}: High variance, check for I/O bottlenecks`)
    }
    if (s.calls > 100 && s.avg > 500) {
      recommendations.push(`  ⚠ ${s.tool}: Frequently slow, optimize hot path`)
    }
  }
  return recommendations
}

// Folds one finished tool call into the stored percentiles for that tool.
async function recordToolCall(perfPath: string, tool: string, duration: number): Promise<void> {
  let perf: PerfData = { lastUpdated: new Date().toISOString(), stats: [] }
  try {
    const existing = await fs.readFile(perfPath, "utf-8")
    perf = JSON.parse(stripBom(existing))
  } catch {
    // File doesn't exist yet, use default
  }

  let toolStats = perf.stats.find(s => s.tool === tool)
  if (!toolStats) {
    toolStats = { tool, calls: 0, totalTime: 0, times: [], p50: 0, p95: 0, p99: 0, avg: 0 }
    perf.stats.push(toolStats)
  }

  toolStats.calls++
  toolStats.totalTime += duration
  toolStats.times.push(duration)

  const sorted = [...toolStats.times].sort((a, b) => a - b)
  toolStats.p50 = calculatePercentile(sorted, 0.5)
  toolStats.p95 = calculatePercentile(sorted, 0.95)
  toolStats.p99 = calculatePercentile(sorted, 0.99)
  toolStats.avg = Math.round(toolStats.totalTime / toolStats.calls)

  perf.lastUpdated = new Date().toISOString()

  await fs.mkdir(path.dirname(perfPath), { recursive: true })
  await fs.writeFile(perfPath, JSON.stringify(perf, null, 2))
}

const perfmonPlugin: V1Plugin = async (input) => {
  const projectRoot = pickProjectRoot(input) ?? input.worktree
  const perfPath = path.join(projectRoot, ".opencode", "perf.json")
  await markPluginLoaded(projectRoot, "speckit-perfmon")

  return {
    "tool.execute.before": async (toolInput, toolOutput) => {
      activeCalls.set(toolInput.callID, {
        start: Date.now(),
        args: toolOutput.args,
      })
    },

    "tool.execute.after": async (toolInput) => {
      const data = activeCalls.get(toolInput.callID)
      if (!data) return

      const duration = Date.now() - data.start
      activeCalls.delete(toolInput.callID)

      await recordToolCall(perfPath, toolInput.tool, duration)
    },
  }
}

export function getRecommendations(perf: PerfData): string[] {
  return generateRecommendations(perf.stats)
}

export function calculatePercentileExport(sorted: number[], percentile: number): number {
  return calculatePercentile(sorted, percentile)
}

export default {
  id: "speckit-perfmon",
  async setup(ctx: V2Plugin.Context): Promise<void> {
    const projectRoot = ctx.location.project.canonical
    const perfPath = path.join(projectRoot, ".opencode", "perf.json")
    await markPluginLoaded(projectRoot, "speckit-perfmon")

    await ctx.tool.hook("execute.before", (event) => {
      activeCalls.set(event.id, {
        start: Date.now(),
        args: event.input,
      })
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const data = activeCalls.get(event.id)
      if (!data) return

      const duration = Date.now() - data.start
      activeCalls.delete(event.id)

      await recordToolCall(perfPath, event.tool, duration)
    })
  },
  server: perfmonPlugin,
}
