import fs from "node:fs/promises"
import path from "node:path"

export class LabPathError extends Error {
  code = "LAB_PATH_UNSAFE"

  constructor(message: string) {
    super(message)
    this.name = "LabPathError"
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

// Limits a variable path piece to portable characters so it cannot smuggle traversal or an absolute path.
export function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new LabPathError(`The lab segment is not a safe id: ${value}`)
  if (value === "." || value === "..") throw new LabPathError("The lab segment cannot be a relative marker")
  return value
}

// Keeps the similarity between Linux and Windows path pieces, because both can carry "..".
// Windows uses backslash separators while POSIX takes them as names, so both forms receive the same fragments.
export function pathFragments(value: string): string[] {
  return path.normalize(value.replace(/\\/g, "/")).split(path.sep).filter((segment) => segment !== "")
}

function normalizeRelative(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new LabPathError("The lab rejects control characters in paths")
  if (/\\/.test(value)) throw new LabPathError("The lab rejects backslash paths because they split on another platform")
  const normalized = path.normalize(value)
  if (path.isAbsolute(normalized)) throw new LabPathError(`The lab rejects an absolute path outside the workspace: ${value}`)
  if (pathFragments(normalized).includes("..")) throw new LabPathError(`The lab rejects traversal out of the workspace: ${value}`)
  if (pathFragments(normalized).length === 0 || normalized === ".") throw new LabPathError("The lab needs a non empty relative path")
  return normalized
}

// Resolves a relative candidate under the workspace and rejects absolute paths or traversal.
export function resolveInside(workspace: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "") throw new LabPathError("The lab needs a path inside the workspace")
  const relative = normalizeRelative(candidate)
  const joined = path.resolve(workspace, relative)
  const workspaceRoot = path.resolve(workspace)
  if (!joined.startsWith(workspaceRoot + path.sep) && joined !== workspaceRoot) {
    throw new LabPathError(`The lab path escaped the workspace: ${candidate}`)
  }
  return joined
}

// Best effort canonical check because an existing link out of the workspace is still an escape.
export async function assertRealInsideWorkspace(workspace: string, candidate: string): Promise<string> {
  const joined = resolveInside(workspace, candidate)
  const workspaceRoot = path.resolve(workspace)
  try {
    const real = await fs.realpath(joined)
    if (real !== workspaceRoot && !real.startsWith(workspaceRoot + path.sep)) {
      throw new LabPathError(`The lab path resolved outside the workspace: ${candidate}`)
    }
    return real
  } catch (error) {
    if (error instanceof LabPathError) throw error
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link still hides a target, so every component gets probed with lstat before the passthrough.
      await assertComponentsInsideWorkspace(workspaceRoot, joined, candidate)
      return joined
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new LabPathError(`Could not resolve the workspace path ${candidate}: ${detail}`)
  }
}

// Walks a missing path segment by segment and lets any link that aims outside the workspace fail loudly.
async function assertComponentsInsideWorkspace(workspaceRoot: string, joined: string, candidate: string): Promise<void> {
  const segments = path.relative(workspaceRoot, joined).split(path.sep)
  let prefix = workspaceRoot
  for (const segment of segments) {
    prefix = path.join(prefix, segment)
    let stat
    try {
      stat = await fs.lstat(prefix)
    } catch {
      // The component is also missing, which stays harmless unless a link shows up later in the chain.
      continue
    }
    if (!stat.isSymbolicLink()) continue
    const target = await fs.readlink(prefix)
    const resolvedTarget = path.resolve(path.dirname(prefix), target)
    if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(workspaceRoot + path.sep)) {
      throw new LabPathError(`The lab path resolved outside the workspace: ${candidate}`)
    }
  }
}

// Rejects an absolute or parent path before it can point outside the sandbox.
export function assertInsideWorkspace(workspace: string, value: string): void {
  const normalized = path.resolve(workspace)
  if (isTraversal(value)) throw new LabPathError(`The lab rejects traversal out of the workspace: ${value}`)
  if (path.isAbsolute(value)) throw new LabPathError(`The lab rejects an absolute path outside the workspace: ${value}`)
  const target = path.resolve(normalized, value)
  if (!target.startsWith(normalized + path.sep)) {
    throw new LabPathError(`The lab path escaped the project workspace: ${value}`)
  }
}

function isTraversal(value: string): boolean {
  return pathFragments(value).includes("..")
}

// Offers a synchronous guard for paths that arrive with a cwd, so an absolute or parent candidate fails before spawn.
export function insideWorkspace(workspace: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "") throw new LabPathError("The lab needs a path inside the workspace")
  const root = path.resolve(workspace)
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new LabPathError(`The lab path escaped the workspace: ${candidate}`)
  }
  return resolved
}
