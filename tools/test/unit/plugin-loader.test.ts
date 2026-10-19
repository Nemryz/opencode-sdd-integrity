import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath } from "../helpers/setup"
import guardShim from "../../../plugins/speckit-guard"
import perfmonShim from "../../../plugins/speckit-perfmon"
import toolsShim from "../../../plugins/speckit-tools"

const PLUGINS_DIR = repoPath("plugins")

describe("local plugin loading shims", () => {
  it("guard shim exposes id and server", () => {
    expect(guardShim.id).toBe("speckit-guard")
    expect(typeof guardShim.server).toBe("function")
  })

  it("perfmon shim exposes id and server", () => {
    expect(perfmonShim.id).toBe("speckit-perfmon")
    expect(typeof perfmonShim.server).toBe("function")
  })

  it("speckit-tools shim exposes the V2 setup and a V1 server", () => {
    expect(toolsShim.id).toBe("speckit-tools")
    expect(typeof toolsShim.setup).toBe("function")
    expect(typeof toolsShim.server).toBe("function")
  })

  it("plugins directory only contains loadable TypeScript shims", async () => {
    const entries = await fs.readdir(PLUGINS_DIR)
    for (const entry of entries) {
      expect(entry.endsWith(".ts")).toBe(true)
    }
    expect(entries).toContain("speckit-guard.ts")
    expect(entries).toContain("speckit-perfmon.ts")
    expect(entries).toContain("speckit-tools.ts")
  })
})
