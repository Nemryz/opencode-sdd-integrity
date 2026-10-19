import type { Plugin as V2Plugin } from "@opencode/plugin"
import fs from "node:fs/promises"
import path from "node:path"

// The smoke probe records the tool registry once the plugin setups ran, so the smoke script can assert the registered names and their exposure without calling every tool.
export default {
  id: "zz-smoke-probe",
  async setup(ctx: V2Plugin.Context): Promise<void> {
    const root = ctx.location.project.canonical
    const dump = async () => {
      try {
        const tools = await ctx.tool.list()
        const data = tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          options: tool.options ?? null,
        }))
        await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
        await fs.writeFile(path.join(root, ".opencode", "smoke-tools.json"), JSON.stringify(data, null, 2))
      } catch {
        // A missing dump fails the smoke script, so the probe swallows the error here.
      }
    }
    await dump()
    setTimeout(() => {
      void dump()
    }, 1500)
  },
  server: () => ({}),
}
