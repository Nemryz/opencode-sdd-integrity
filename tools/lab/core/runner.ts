import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { DEFAULT_LAB_ENV, SAFE_HINTS, safeLabEnvironment } from "./environment"

export interface LabProcessLimits {
  cpuSeconds?: number
  memoryBytes?: number
}

export interface LabProcessOptions {
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
  limits?: LabProcessLimits
  env?: NodeJS.ProcessEnv
  allowList?: string[]
  signal?: AbortSignal
}

export interface LabProcessResult {
  code: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

let prlimitAvailable: boolean | null = null

function hasPrlimit(): boolean {
  if (prlimitAvailable !== null) return prlimitAvailable
  const probe = spawnSync("prlimit", ["--version"], { stdio: "ignore", windowsHide: true })
  prlimitAvailable = !probe.error && probe.status === 0
  return prlimitAvailable
}

// Wraps the command in prlimit on POSIX so cpu and memory caps come from the kernel, and errors instead of downgrading.
export function limitsWrapper(limits: LabProcessLimits | undefined): { command: string; args: string[] } | null {
  if (!limits || (limits.cpuSeconds === undefined && limits.memoryBytes === undefined)) return null
  if (process.platform === "win32") {
    throw new Error("The lab cannot enforce cpu or memory limits on Windows yet; remove the limits or run on POSIX")
  }
  if (!hasPrlimit()) {
    throw new Error("The requested cpu or memory limits need prlimit on PATH; remove the limits or install util-linux")
  }
  const args: string[] = []
  if (limits.cpuSeconds !== undefined) {
    args.push("--cpu", String(Math.floor(limits.cpuSeconds)))
  }
  if (limits.memoryBytes !== undefined) {
    args.push("--as", String(Math.floor(limits.memoryBytes)))
  }
  return { command: "prlimit", args }
}

function terminateTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {})
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // the process already exited
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // the process already exited
    }
  }, 1500).unref()
}

export interface LabSpawnInvocation {
  command: string
  args: string[]
  verbatim: boolean
}

// Wraps a token in the quotes cmd.exe expects and doubles an inner quote because cmd has no backslash escape.
function quoteCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

// Scans PATH with PATHEXT so a bare name that resolves to a batch shim is distinguishable from a real executable.
function findShimOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? env.Path ?? "").split(path.delimiter)
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry !== "")
  for (const entry of entries) {
    if (entry === "") continue
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`)
      if (existsSync(candidate)) return /\.(cmd|bat)$/i.test(candidate) ? candidate : null
    }
  }
  return null
}

// Looks up an exact file name across PATH entries so a quoted shim token never depends on the cmd search rules.
function resolveOnPath(file: string, env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? env.Path ?? "").split(path.delimiter)
  for (const entry of entries) {
    if (entry === "") continue
    const candidate = path.join(entry, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// Keeps the direct spawn for real executables and routes cmd and bat shims through ComSpec with one verbatim tail.
export function normalizeSpawnInvocation(
  command: string,
  args: string[],
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): LabSpawnInvocation {
  if (platform !== "win32") return { command, args, verbatim: false }
  let shim: string | null = null
  if (/\.(cmd|bat)$/i.test(command)) shim = /[\\/]/.test(command) ? command : (resolveOnPath(command, env) ?? command)
  else if (!/[\\/]/.test(command)) shim = findShimOnPath(command, env)
  if (!shim) return { command, args, verbatim: false }
  for (const value of [shim, ...args]) {
    if (/[\u0000-\u001f]/.test(value)) throw new Error("The lab refuses control characters in a cmd.exe command line")
    if (value.includes("%")) throw new Error("The lab refuses percent signs in a cmd.exe command line because cmd expands environment variables")
  }
  const payload = [shim, ...args].map(quoteCmdArgument).join(" ")
  return { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${payload}"`], verbatim: true }
}

export function runLabProcess(command: string, args: string[], options: LabProcessOptions): Promise<LabProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const limit = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    let forceTimer: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    let child: ChildProcess

    const append = (current: string, chunk: string): string => {
      const next = current + chunk
      if (next.length > limit) {
        truncated = true
        return next.slice(0, limit)
      }
      return next
    }

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        truncated,
      })
    }

    const onAbort = (): void => {
      if (settled) return
      aborted = true
      terminateTree(child)
      if (!forceTimer) forceTimer = setTimeout(() => finish(1), 5000)
    }

    try {
      const env = safeLabEnvironment(process.env, [...SAFE_HINTS, ...(options.allowList ?? [])], {
        ...DEFAULT_LAB_ENV,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        NO_PROXY: "*",
        no_proxy: "*",
        ...options.env,
      })
      const wrapper = limitsWrapper(options.limits)
      const invocation = wrapper
        ? { command: wrapper.command, args: [...wrapper.args, "--", command, ...args], verbatim: false }
        : normalizeSpawnInvocation(command, args)
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        windowsVerbatimArguments: invocation.verbatim,
      })
    } catch (error) {
      resolve({
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        truncated,
      })
      return
    }

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, String(chunk))
    })
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, String(chunk))
    })
    child.on("error", (error) => {
      stderr = append(stderr, `${error.message}\n`)
      finish(1)
    })
    child.on("close", (code) => finish(code ?? 1))

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        terminateTree(child)
        if (!forceTimer) forceTimer = setTimeout(() => finish(1), 5000)
      }, timeoutMs)
    }

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true })
    }
  })
}
