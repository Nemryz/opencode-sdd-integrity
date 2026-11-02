import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runLabProcess, normalizeSpawnInvocation } from "../../lab/core/runner"

describe("corpus spawn invocation", () => {
  it("keeps a posix command untouched so the wrapper and the shim logic never overlap", () => {
    const invocation = normalizeSpawnInvocation("npm", ["install"], "linux", { PATH: "/usr/bin" })
    expect(invocation).toEqual({ command: "npm", args: ["install"], verbatim: false })
  })

  it("routes a bare shim name found on the windows path through ComSpec", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-shim-"))
    try {
      await fs.writeFile(path.join(root, "npm.cmd"), "@echo off\r\n", "utf-8")
      const invocation = normalizeSpawnInvocation("npm", ["--version"], "win32", {
        PATH: root,
        PATHEXT: ".cmd",
        ComSpec: "cmd.exe",
      })
      expect(invocation.command).toBe("cmd.exe")
      expect(invocation.verbatim).toBe(true)
      expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
      expect(invocation.args[3]).toContain("npm.cmd")
      expect(invocation.args[3]).toContain("--version")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("leaves a real executable on the windows path on the direct spawn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-shim-"))
    try {
      await fs.writeFile(path.join(root, "git.EXE"), "", "utf-8")
      const invocation = normalizeSpawnInvocation("git", ["status"], "win32", { PATH: root, PATHEXT: ".EXE;.CMD" })
      expect(invocation).toEqual({ command: "git", args: ["status"], verbatim: false })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("quotes every token of the cmd tail so metacharacters stay inside one argument", () => {
    const invocation = normalizeSpawnInvocation("npm.cmd", ["run", "a b", "x&y"], "win32", {})
    expect(invocation.command).toBe("cmd.exe")
    expect(invocation.args[3]).toBe('""npm.cmd" "run" "a b" "x&y""')
  })

  it("resolves an explicit shim name against the injected path instead of trusting cmd search", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-shim-"))
    try {
      await fs.writeFile(path.join(root, "npm.cmd"), "@echo off\r\n", "utf-8")
      const invocation = normalizeSpawnInvocation("npm.cmd", ["--version"], "win32", { PATH: root, ComSpec: "cmd.exe" })
      expect(invocation.command).toBe("cmd.exe")
      expect(invocation.args[3]).toContain(path.join(root, "npm.cmd"))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("refuses percent signs on the cmd route instead of letting cmd expand them", () => {
    expect(() => normalizeSpawnInvocation("npm.cmd", ["--prefix=%PATH%"], "win32", {})).toThrow("percent signs")
  })

  it("refuses control characters on the cmd route before anything spawns", () => {
    expect(() => normalizeSpawnInvocation("npm.cmd", ["line\nbreak"], "win32", {})).toThrow("control characters")
  })
})

describe("corpus windows cmd shims", () => {
  it.runIf(process.platform === "win32")("runs npm through its cmd shim with the runner normalization", async () => {
    const result = await runLabProcess("npm", ["--version"], { cwd: os.tmpdir(), timeoutMs: 30_000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it.runIf(process.platform === "win32")("accepts an explicit cmd shim name as the command", async () => {
    const result = await runLabProcess("npm.cmd", ["--version"], { cwd: os.tmpdir(), timeoutMs: 30_000 })
    expect(result.code, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it.runIf(process.platform === "win32")("keeps spaced and metacharacter arguments literal through cmd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-probe-"))
    try {
      await fs.writeFile(path.join(root, "probe.cmd"), "@echo off\r\necho %*\r\n", "utf-8")
      const result = await runLabProcess(path.join(root, "probe.cmd"), ["hello world", "x&echo INJECTED"], {
        cwd: root,
        timeoutMs: 20_000,
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("hello world")
      expect(result.stdout).toContain("x&echo INJECTED")
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("refuses a percent sign argument before spawning cmd", async () => {
    const result = await runLabProcess("npm.cmd", ["--prefix=%PATH%"], { cwd: os.tmpdir(), timeoutMs: 10_000 })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("percent signs")
  })
})
