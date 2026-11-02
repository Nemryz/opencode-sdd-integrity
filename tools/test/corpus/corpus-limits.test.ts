import { describe, it, expect } from "vitest"
import { runLabProcess, limitsWrapper } from "../../lab/core/runner"
import os from "node:os"
import path from "node:path"

// Waits until both pids are gone, because the tree terminator needs a grace period before its hard kill.
async function assertGroupDead(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (alive.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`The lab did not finish the process tree: ${pids.join(", ")}`)
}

describe("corpus output exhaustion", () => {
  it("caps the captured output when a step floods stdout and notes the truncation", async () => {
    const looper = `for (let i = 0; i < 20000; i += 1) { console.log("corpus flood line with padding") }`
    const result = await runLabProcess(process.execPath, ["-e", looper], {
      cwd: os.tmpdir(),
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(4096)
  })

  it("applies the same capture cap to stderr floods", async () => {
    const looper = `for (let i = 0; i < 20000; i += 1) { console.error("corpus noise line with padding") }`
    const result = await runLabProcess(process.execPath, ["-e", looper], {
      cwd: os.tmpdir(),
      timeoutMs: 20_000,
      maxOutputBytes: 8192,
    })
    expect(result.truncated).toBe(true)
    expect(result.stderr.length).toBeLessThanOrEqual(8192)
  })
})

describe("corpus timeout exhaustion", () => {
  it("finishes the whole process tree when a runaway step crosses its timeout", async () => {
    const tree = [
      `const { spawn } = require("node:child_process")`,
      `const inner = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"])`,
      `console.log(JSON.stringify({ parent: process.pid, inner: inner.pid }))`,
      `setInterval(() => {}, 200)`,
    ].join("\n")
    const result = await runLabProcess(process.execPath, ["-e", tree], {
      cwd: os.tmpdir(),
      timeoutMs: 700,
    })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(1)
    const reported = JSON.parse(result.stdout.trim().split("\n")[0]) as { parent: number, inner: number }
    await assertGroupDead([reported.parent, reported.inner])
  })
})

describe("corpus kernel limits", () => {
  it.skipIf(process.platform === "win32")("builds a prlimit wrapper that keeps the original argv after the caps", () => {
    const wrapper = limitsWrapper({ cpuSeconds: 3, memoryBytes: 1 << 30 })
    expect(wrapper).toEqual({ command: "prlimit", args: ["--cpu", "3", "--as", "1073741824"] })
    expect(limitsWrapper({})).toBeNull()
    expect(limitsWrapper(undefined)).toBeNull()
  })

  it.skipIf(process.platform === "win32")("stops a busy loop child with a cpu ceiling instead of letting it burn the host", async () => {
    const result = await runLabProcess(
      process.execPath,
      ["-e", "setImmediate(function burn(){ setImmediate(burn) })"],
      { cwd: os.tmpdir(), timeoutMs: 20_000, limits: { cpuSeconds: 1 } },
    )
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.durationMs).toBeLessThan(15_000)
  })

  it.skipIf(process.platform === "win32")("refuses to boot a node child whose virtual memory lied below its own needs", async () => {
    const result = await runLabProcess(process.execPath, ["-e", "console.log(1)"], {
      cwd: path.join(os.tmpdir()),
      timeoutMs: 20_000,
      limits: { memoryBytes: 100 * 1024 * 1024 },
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
  })
})

describe("corpus windows limit refusal", () => {
  it.runIf(process.platform === "win32")("refuses kernel limits with an explicit message instead of pretending", () => {
    expect(() => limitsWrapper({ cpuSeconds: 3 })).toThrow("cannot enforce cpu or memory limits on Windows")
    expect(() => limitsWrapper({ memoryBytes: 1 << 20 })).toThrow("cannot enforce cpu or memory limits on Windows")
  })

  it.runIf(process.platform === "win32")("fails a limited step through the runner before anything spawns", async () => {
    const result = await runLabProcess(process.execPath, ["-e", "console.log(1)"], {
      cwd: os.tmpdir(),
      timeoutMs: 20_000,
      limits: { cpuSeconds: 3 },
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("cannot enforce cpu or memory limits")
  })
})
