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

const WIN32_RESERVED_DEVICES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

// Windows keeps a device behind a file name even when an extension follows, so the stem before the first dot decides.
function isReservedDeviceSegment(segment: string): boolean {
  const cut = segment.indexOf(".")
  return WIN32_RESERVED_DEVICES.has((cut === -1 ? segment : segment.slice(0, cut)).toLowerCase())
}

// Windows reads a letter plus a colon as a drive or a drive relative target, so the shape is flagged everywhere before resolve runs.
function isDriveLetterSegment(segment: string): boolean {
  return /^[A-Za-z]:/.test(segment)
}

// Limits a variable path piece to portable characters so it cannot smuggle traversal, an absolute path or a Windows device.
export function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new LabPathError(`The lab segment is not a safe id: ${value}`)
  if (value === "." || value === "..") throw new LabPathError("The lab segment cannot be a relative marker")
  if (/\.$/.test(value)) throw new LabPathError(`The lab segment cannot end in a dot because Windows drops it: ${value}`)
  if (isDriveLetterSegment(value)) throw new LabPathError(`The lab segment cannot open a drive on Windows: ${value}`)
  if (isReservedDeviceSegment(value)) throw new LabPathError(`The lab segment names a reserved Windows device: ${value}`)
  return value
}

// Keeps the similarity between Linux and Windows path pieces, because both can carry "..".
// Windows uses backslash separators while POSIX takes them as names, so both forms receive the same fragments.
export function pathFragments(value: string): string[] {
  return path.normalize(value.replace(/\\/g, "/")).split(path.sep).filter((segment) => segment !== "" && segment.trim() !== "")
}

// Screens the relative fragments against the hazards shared by every platform so the three guards enforce the same list.
function screenRelativeSegments(segments: string[], candidate: string): void {
  for (const segment of segments) {
    if (segment !== segment.trim()) throw new LabPathError(`The lab rejects a path segment with surrounding whitespace: ${candidate}`)
    if (/\.$/.test(segment) && segment.length > 1) throw new LabPathError(`The lab rejects a path segment ending in a dot: ${candidate}`)
    if (isDriveLetterSegment(segment)) throw new LabPathError(`The lab rejects a drive letter path because it is absolute on Windows: ${candidate}`)
    if (isReservedDeviceSegment(segment)) throw new LabPathError(`The lab rejects a reserved Windows device name: ${candidate}`)
  }
}

function normalizeRelative(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new LabPathError("The lab rejects control characters in paths")
  if (process.platform !== "win32" && /\\/.test(value)) throw new LabPathError("The lab rejects backslash paths because they split on another platform")
  const slashNormalized = process.platform === "win32" ? value.replace(/\\/g, "/") : value
  const normalized = path.normalize(slashNormalized)
  if (path.isAbsolute(normalized)) throw new LabPathError(`The lab rejects an absolute path outside the workspace: ${value}`)
  if (pathFragments(normalized).includes("..")) throw new LabPathError(`The lab rejects traversal out of the workspace: ${value}`)
  if (pathFragments(normalized).length === 0 || normalized === ".") throw new LabPathError("The lab needs a non empty relative path")
  screenRelativeSegments(pathFragments(normalized), value)
  return normalized
}

// Resolves a relative candidate under the workspace and rejects absolute paths or traversal.
export function resolveInside(workspace: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate === "." || candidate === "..") throw new LabPathError("The lab needs a path inside the workspace")
  const relative = normalizeRelative(candidate)
  const joined = path.resolve(workspace, relative)
  const workspaceRoot = path.resolve(workspace)
  if (!joined.startsWith(workspaceRoot + path.sep) && joined !== workspaceRoot) {
    throw new LabPathError(`The lab path escaped the workspace: ${candidate}`)
  }
  return joined
}

// Detects a Windows junction or reparse point by probing readlink on a directory that lstat does not mark as a symlink.
async function isReparsePoint(target: string): Promise<boolean> {
  let stat
  try {
    stat = await fs.lstat(target)
  } catch {
    return false
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  try {
    await fs.readlink(target)
    return true
  } catch {
    return false
  }
}
export async function assertRealInsideWorkspace(workspace: string, candidate: string): Promise<string> {
  const workspaceRoot = await fs.realpath(path.resolve(workspace)).catch(() => path.resolve(workspace))
  const joined = resolveInside(workspaceRoot, candidate)
  if (await isReparsePoint(joined)) {
    throw new LabPathError(`The lab rejects a reparse point inside the workspace: ${candidate}`)
  }
  try {
    const real = await fs.realpath(joined)
    const stripPrefix = (p: string) => p.replace(/^\\\\\\?\\/, "")
    const normalizedReal = stripPrefix(process.platform === "win32" ? real.toLowerCase() : real)
    const normalizedRoot = stripPrefix(process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot)
    if (normalizedReal !== normalizedRoot && !normalizedReal.startsWith(normalizedRoot + path.sep)) {
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
    if (!stat.isSymbolicLink()) {
      if (stat.isDirectory() && (await isReparsePoint(prefix))) {
        throw new LabPathError(`The lab rejects a reparse point inside the workspace: ${candidate}`)
      }
      continue
    }
    const target = await fs.readlink(prefix)
    const resolvedTarget = path.resolve(path.dirname(prefix), target)
    if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(workspaceRoot + path.sep)) {
      throw new LabPathError(`The lab path resolved outside the workspace: ${candidate}`)
    }
  }
}

// Rejects an absolute or parent path before it can point outside the sandbox.
export function assertInsideWorkspace(workspace: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new LabPathError("The lab needs a path inside the workspace")
  if (process.platform !== "win32" && /\\/.test(value)) throw new LabPathError("The lab rejects backslash paths because they split on another platform")
  if (/[\u0000-\u001f]/.test(value)) throw new LabPathError("The lab rejects control characters in paths")
  if (pathFragments(value).length === 0) throw new LabPathError("The lab needs a non empty relative path")
  screenRelativeSegments(pathFragments(value), value)
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
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate === "." || candidate === "..") throw new LabPathError("The lab needs a path inside the workspace")
  if (process.platform !== "win32" && /\\/.test(candidate)) throw new LabPathError("The lab rejects backslash paths because they split on another platform")
  if (pathFragments(candidate).length === 0) throw new LabPathError("The lab needs a non empty relative path")
  screenRelativeSegments(pathFragments(candidate), candidate)
  const root = path.resolve(workspace)
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new LabPathError(`The lab path escaped the workspace: ${candidate}`)
  }
  return resolved
}
