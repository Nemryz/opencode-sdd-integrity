import fs from "node:fs/promises"
import path from "node:path"
import type { LabRegistry, LabRunSummary, LabSandbox } from "./types"
import { makeLabId, readJson, withLabLock, writeJsonAtomic } from "./fs"

export function labRoot(projectRoot: string): string {
  return path.join(projectRoot, "reports", "lab")
}

export function registryFile(projectRoot: string): string {
  return path.join(labRoot(projectRoot), "registry.json")
}

export function registryLock(projectRoot: string): string {
  return path.join(labRoot(projectRoot), "registry.lock")
}

export function sandboxReportDir(projectRoot: string, sandboxId: string): string {
  return path.join(labRoot(projectRoot), sandboxId)
}

export function runDir(projectRoot: string, sandboxId: string, runId: string): string {
  return path.join(sandboxReportDir(projectRoot, sandboxId), "runs", runId)
}

export function diffDir(projectRoot: string, sandboxId: string): string {
  return path.join(sandboxReportDir(projectRoot, sandboxId), "diffs")
}

export function makeRunId(): string {
  return makeLabId()
}

export async function readRegistry(projectRoot: string): Promise<LabRegistry> {
  const parsed = await readJson<LabRegistry>(registryFile(projectRoot))
  if (!parsed) return { version: 1, sandboxes: [] }
  if (parsed.version !== 1 || !Array.isArray(parsed.sandboxes)) {
    throw new Error(`Lab registry is unreadable: ${registryFile(projectRoot)}`)
  }
  return parsed
}

export async function writeRegistry(projectRoot: string, registry: LabRegistry): Promise<void> {
  await writeJsonAtomic(registryFile(projectRoot), registry)
}

export async function listSandboxes(projectRoot: string): Promise<LabSandbox[]> {
  const registry = await readRegistry(projectRoot)
  return [...registry.sandboxes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getSandbox(projectRoot: string, id: string): Promise<LabSandbox | null> {
  const registry = await readRegistry(projectRoot)
  return registry.sandboxes.find((entry) => entry.id === id) ?? null
}

export async function latestSandbox(projectRoot: string): Promise<LabSandbox | null> {
  const sandboxes = await listSandboxes(projectRoot)
  return sandboxes.find((entry) => entry.status === "active" || entry.status === "promoted") ?? null
}

export async function upsertSandbox(projectRoot: string, sandbox: LabSandbox): Promise<void> {
  await withLabLock(registryLock(projectRoot), async () => {
    const registry = await readRegistry(projectRoot)
    const index = registry.sandboxes.findIndex((entry) => entry.id === sandbox.id)
    if (index === -1) registry.sandboxes.push(sandbox)
    else registry.sandboxes[index] = sandbox
    await writeRegistry(projectRoot, registry)
  })
}

export async function updateSandbox(
  projectRoot: string,
  id: string,
  patch: Partial<LabSandbox>,
): Promise<LabSandbox | null> {
  return withLabLock(registryLock(projectRoot), async () => {
    const registry = await readRegistry(projectRoot)
    const index = registry.sandboxes.findIndex((entry) => entry.id === id)
    if (index === -1) return null
    const updated = { ...registry.sandboxes[index], ...patch, id }
    registry.sandboxes[index] = updated
    await writeRegistry(projectRoot, registry)
    return updated
  })
}

export async function writeRunSummary(projectRoot: string, summary: LabRunSummary): Promise<void> {
  const file = path.join(runDir(projectRoot, summary.sandboxId, summary.runId), "summary.json")
  await writeJsonAtomic(file, summary)
  await updateSandbox(projectRoot, summary.sandboxId, {
    lastRunAt: summary.finishedAt,
    lastRunStatus: summary.status,
    lastRunId: summary.runId,
  })
}

export async function readRunSummary(projectRoot: string, sandboxId: string, runId: string): Promise<LabRunSummary | null> {
  return readJson<LabRunSummary>(path.join(runDir(projectRoot, sandboxId, runId), "summary.json"))
}

export async function latestRunSummary(projectRoot: string, sandboxId: string): Promise<LabRunSummary | null> {
  const directory = path.join(sandboxReportDir(projectRoot, sandboxId), "runs")
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  for (const entry of entries.sort((a, b) => b.localeCompare(a))) {
    const summary = await readRunSummary(projectRoot, sandboxId, entry)
    if (summary) return summary
  }
  return null
}

export async function ensureRunDir(projectRoot: string, sandboxId: string, runId: string): Promise<string> {
  const directory = runDir(projectRoot, sandboxId, runId)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

export async function ensureDiffDir(projectRoot: string, sandboxId: string): Promise<string> {
  const directory = diffDir(projectRoot, sandboxId)
  await fs.mkdir(directory, { recursive: true })
  return directory
}
