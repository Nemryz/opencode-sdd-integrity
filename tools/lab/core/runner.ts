import { spawn, type ChildProcess } from "node:child_process"

export interface LabProcessOptions {
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
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
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
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
