import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { McpServer, MatrixServer } from "../mcp/mcp-fixtures"
import { REPO_ROOT } from "../mcp/mcp-fixtures"

export class MissingEnvError extends Error {
  constructor(readonly envName: string) {
    super(`missing environment variable ${envName}`)
    this.name = "MissingEnvError"
  }
}

export type ProbeResult = {
  name: string
  serverName: string
  serverVersion?: string
  tools: string[]
}

export type McpBaseline = {
  servers: Record<string, ProbeResult>
}

export function resolveEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = env[name]
      if (!resolved) throw new MissingEnvError(name)
      return resolved
    }) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnv(item, env)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveEnv(item, env)]),
    ) as T
  }
  return value
}

export function commandExists(command: string, cwd?: string): boolean {
  if (!command) return false
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd ?? process.cwd(), command)
    return fs.existsSync(candidate)
  }
  const finder = process.platform === "win32" ? "where" : "which"
  const result = spawnSync(finder, [command], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  return result.status === 0
}

export function probeTimeout(meta: MatrixServer): number {
  return meta.timeout ? meta.timeout + 5000 : 60000
}

function withTimeout<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function childEnvironment(environment: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...environment })) {
    if (typeof value === "string") merged[key] = value
  }
  return merged
}

export function killProcessTree(pid: number | null | undefined): void {
  if (!pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5000,
    })
    return
  }
  spawnSync("pkill", ["-TERM", "-P", String(pid)], {
    stdio: "ignore",
    timeout: 5000,
  })
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // the process already exited
  }
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.close()
  } catch {
    // a transport that already closed is fine
  }
}

async function probeLocal(server: McpServer, meta: MatrixServer): Promise<ProbeResult> {
  const command = server.command?.[0]
  if (!command) throw new Error(`missing command for ${meta.name}`)
  if (!commandExists(command, server.cwd)) throw new Error(`command not found for ${meta.name}: ${command}`)
  const transport = new StdioClientTransport({
    command,
    args: server.command?.slice(1),
    env: childEnvironment(server.environment),
    cwd: server.cwd,
    stderr: "pipe",
  })
  const client = new Client({ name: "sdd-mcp-probe", version: "1.0.0" })
  const timeout = probeTimeout(meta)
  let pid: number | null = null
  try {
    await withTimeout(client.connect(transport), timeout, `${meta.name} connect`)
    pid = transport.pid
    const listed = await withTimeout(client.listTools(), timeout, `${meta.name} listTools`)
    const info = client.getServerVersion()
    return {
      name: meta.name,
      serverName: info?.name ?? meta.name,
      serverVersion: info?.version,
      tools: listed.tools.map((tool) => tool.name).sort(),
    }
  } finally {
    await closeClient(client)
    killProcessTree(pid ?? transport.pid)
  }
}

async function probeRemote(server: McpServer, meta: MatrixServer): Promise<ProbeResult> {
  const url = server.url
  if (!url) throw new Error(`missing url for ${meta.name}`)
  const timeout = probeTimeout(meta)
  const target = new URL(url)
  const headers = server.headers
  const attempts = [
    () => new StreamableHTTPClientTransport(target, { requestInit: { headers } }),
    () => new SSEClientTransport(target, { requestInit: { headers } }),
  ]
  let lastError: unknown = null
  for (const makeTransport of attempts) {
    const transport = makeTransport()
    const client = new Client({ name: "sdd-mcp-probe", version: "1.0.0" })
    try {
      await withTimeout(client.connect(transport), timeout, `${meta.name} connect`)
      const listed = await withTimeout(client.listTools(), timeout, `${meta.name} listTools`)
      const info = client.getServerVersion()
      return {
        name: meta.name,
        serverName: info?.name ?? meta.name,
        serverVersion: info?.version,
        tools: listed.tools.map((tool) => tool.name).sort(),
      }
    } catch (error) {
      lastError = error
      await closeClient(client)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`could not connect to ${meta.name}`)
}

export async function probeServer(meta: MatrixServer, server: McpServer): Promise<ProbeResult> {
  const resolved = resolveEnv(server)
  return resolved.type === "local" ? probeLocal(resolved, meta) : probeRemote(resolved, meta)
}

export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|connection refused|socket|network|timed out/i.test(message)
}

export function baselinePath(): string {
  return process.env.MCP_BASELINE_PATH ?? path.join(os.homedir(), ".opencode", "mcp-baseline.json")
}

export function assertBaselineOutsideRepo(filePath: string): void {
  const resolved = path.resolve(filePath)
  const relative = path.relative(REPO_ROOT, resolved)
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  if (inside) throw new Error(`MCP baseline must live outside the repository, received ${resolved}`)
}

export function loadBaseline(filePath: string): McpBaseline | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as McpBaseline
}

export function writeBaseline(filePath: string, results: ProbeResult[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const servers = Object.fromEntries(results.map((result) => [result.name, result]))
  fs.writeFileSync(filePath, JSON.stringify({ servers }, null, 2) + "\n")
}
