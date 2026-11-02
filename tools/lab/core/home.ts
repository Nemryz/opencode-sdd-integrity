import fs from "node:fs/promises"
import path from "node:path"

export interface LabHomeLayout {
  home: string
  sandboxes: string
  reports: string
  baselines: string
  registry: string
  patches: string
  audit: string
  sessions: string
}

const HOME_PERMISSION = 0o700

// Keeps every runtime state directory inside the project, so the lab never writes behind the author's back.
export function labPaths(projectRoot: string): LabHomeLayout {
  const home = path.resolve(projectRoot, ".opencode", "lab")
  return {
    home,
    sandboxes: path.join(home, "sandboxes"),
    reports: path.join(home, "reports"),
    baselines: path.join(home, "baselines"),
    registry: path.join(home, "registry"),
    patches: path.join(home, "patches"),
    audit: path.join(home, "audit"),
    sessions: path.join(home, "sessions"),
  }
}

export function sandboxRoot(projectRoot: string, id: string): string {
  return path.join(labPaths(projectRoot).sandboxes, id)
}

// Confirms a value points at or under the sandbox tree, which prune uses to spot orphans.
export function isLabSandboxRoot(projectRoot: string, value: string): boolean {
  const expected = path.resolve(labPaths(projectRoot).sandboxes)
  const actual = path.resolve(value)
  return actual === expected || actual.startsWith(`${expected}${path.sep}`)
}

export async function ensureLabHome(projectRoot: string): Promise<LabHomeLayout> {
  const paths = labPaths(projectRoot)
  for (const dir of [paths.home, paths.sandboxes, paths.reports, paths.baselines, paths.registry, paths.patches, paths.audit, paths.sessions]) {
    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, HOME_PERMISSION)
  }
  let observed = false
  try {
    const target = path.join(projectRoot, ".opencode")
    const targetStat = await fs.lstat(target)
    observed = targetStat.isSymbolicLink()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // First creation is normal.
    } else {
      throw error
    }
  }
  if (observed) {
    await fs.writeFile(path.join(paths.home, "SYMLINK_WARNING.txt"), "The project .opencode directory was already a symlink.\n", "utf-8")
  }
  await ensureHomeGitignore(paths.home)
  return paths
}

async function ensureHomeGitignore(home: string): Promise<void> {
  const file = path.join(home, ".gitignore")
  try {
    await fs.access(file)
    return
  } catch {
    // Initial write lands here.
  }
  const patterns = [
    "sandboxes/",
    "reports/",
    "baselines/",
    "registry/",
    "patches/",
    "audit/",
    "",
  ]
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(file, `${patterns.join("\n")}\n`, "utf-8")
}
