import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import speckitApprove from "../speckit-approve"
import speckitArchive from "../speckit-archive"
import speckitAudit from "../speckit-audit"
import speckitClean from "../speckit-clean"
import speckitComplexity from "../speckit-complexity"
import speckitConfig from "../speckit-config"
import speckitDelta from "../speckit-delta"
import speckitEvidence from "../speckit-evidence"
import speckitGuard from "../speckit-guard"
import speckitHealth from "../speckit-health"
import speckitMutation from "../speckit-mutation"
import speckitPerf from "../speckit-perf"
import speckitPhase from "../speckit-phase"
import speckitScaffold from "../speckit-scaffold"
import speckitSelfheal from "../speckit-selfheal"
import speckitSnapshot from "../speckit-snapshot"
import speckitStatus from "../speckit-status"
import speckitValidate from "../speckit-validate"

const REGISTERED_TOOLS: ReadonlyArray<{ name: string; def: ToolDefinition }> = [
  { name: "speckit-approve", def: speckitApprove },
  { name: "speckit-archive", def: speckitArchive },
  { name: "speckit-audit", def: speckitAudit },
  { name: "speckit-clean", def: speckitClean },
  { name: "speckit-complexity", def: speckitComplexity },
  { name: "speckit-config", def: speckitConfig },
  { name: "speckit-delta", def: speckitDelta },
  { name: "speckit-evidence", def: speckitEvidence },
  { name: "speckit-guard", def: speckitGuard },
  { name: "speckit-health", def: speckitHealth },
  { name: "speckit-mutation", def: speckitMutation },
  { name: "speckit-perf", def: speckitPerf },
  { name: "speckit-phase", def: speckitPhase },
  { name: "speckit-scaffold", def: speckitScaffold },
  { name: "speckit-selfheal", def: speckitSelfheal },
  { name: "speckit-snapshot", def: speckitSnapshot },
  { name: "speckit-status", def: speckitStatus },
  { name: "speckit-validate", def: speckitValidate },
]

// Drops undefined values that would leave the V2 runtime tool part stuck in running forever.
function jsonSafeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  try {
    const clean = JSON.parse(JSON.stringify(metadata))
    return clean !== null && typeof clean === "object" && !Array.isArray(clean) ? clean : {}
  } catch {
    return metadata
  }
}

// Turns a V1 tool result into the structured content the V2 runtime expects.
export function toPluginContent(result: unknown): { content: string; metadata?: Record<string, unknown> } {
  if (typeof result === "string") return { content: result }
  const value = (result ?? {}) as { title?: string; output?: string; metadata?: Record<string, unknown> }
  const metadata: Record<string, unknown> = jsonSafeMetadata(value.metadata ?? {})
  if (typeof value.title === "string" && value.title.length > 0 && metadata.title === undefined) {
    metadata.title = value.title
  }
  if (Object.keys(metadata).length === 0) return { content: value.output ?? "" }
  return { content: value.output ?? "", metadata }
}

export default {
  id: "speckit-tools",
  async setup(ctx: V2Plugin.Context): Promise<void> {
    const projectRoot = ctx.location.project.canonical

    await ctx.tool.transform((editor) => {
      for (const { name, def } of REGISTERED_TOOLS) {
        const argsSchema = z.object(def.args)
        editor.add({
          name,
          description: def.description,
          // Bridges the zod JSON Schema output to the effect schema type the V2 editor expects.
          input: z.toJSONSchema(argsSchema) as any,
          // Keeps every tool callable as a first class tool on OpenCode 2, matching the way OpenCode 1 presents them.
          options: { codemode: false },
          async execute(input, context) {
            try {
              const args = argsSchema.parse(input ?? {})
              const toolContext = {
                sessionID: context.sessionID,
                messageID: context.messageID,
                agent: context.agent,
                directory: projectRoot,
                worktree: projectRoot,
                abort: context.signal,
              }
              const result = await def.execute(args, toolContext as any)
              return toPluginContent(result)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              return { content: `${name}: ${message}`, metadata: { error: message } }
            }
          },
        })
      }
    })
  },
}
