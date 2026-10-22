import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { LabDependencyState, LabPackageManager, LabSandbox } from "./types"
import { ensureDir } from "./fs"
import { linkNodeModules } from "./git"
import { updateSandbox } from "./registry"
import { outputTail, stripAnsi } from "./report"
import { runLabProcess, type LabProcessResult } from "./runner"

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const INSTALL_OUTPUT_LIMIT = 4 * 1024 * 1024

interface LockfileDefinition {
  file: string
  manager: LabPackageManager
}

// npm gives shrinkwrap precedence over package-lock, so the order is intentional.
const LOCKFILES: readonly LockfileDefinition[] = [
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
]

export interface LockfileState {
  file: string
  manager: LabPackageManager
  hash: string
}

export type DependencyAction = "ready" | "link" | "install" | "error"

export interface DependencyDecision {
  action: DependencyAction
  reason: string
}

export interface DependencyInput {
  source: LockfileState | null
  sandbox: LockfileState | null
  current?: LabDependencyState
  sandboxHasNodeModules: boolean
  sourceHasNodeModules: boolean
}

export interface EnsureDependenciesOptions {
  projectRoot: string
  sandbox: LabSandbox
  reportDir: string
}

export interface EnsureDependenciesResult {
  sandbox: LabSandbox
  note?: string
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

export async function readLockfile(root: string): Promise<LockfileState | null> {
  for (const definition of LOCKFILES) {
    const file = path.join(root, definition.file)
    try {
      const contents = await fs.readFile(file)
      // Git may check text lockfiles out with CRLF on Windows, so compare their logical lines.
      const normalized = definition.file.endsWith(".lockb")
        ? contents
        : Buffer.from(contents.toString("utf-8").replace(/\r\n/g, "\n"), "utf-8")
      return {
        file: definition.file,
        manager: definition.manager,
        hash: crypto.createHash("sha256").update(normalized).digest("hex"),
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return null
}

export async function hasNodeModules(root: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, "node_modules"))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function sameLockfile(left: LockfileState | null, right: LockfileState | null): boolean {
  return Boolean(left && right && left.file === right.file && left.hash === right.hash)
}

function matchesInstalledState(current: LabDependencyState | undefined, lockfile: LockfileState): boolean {
  if (current?.strategy !== "installed") return false
  if (current.lockfile && current.lockfile !== lockfile.file) return false
  return current.lockHash === lockfile.hash
}

// Pure decision table so the dependency policy can be tested without spawning a package manager.
export function planDependencyAction(input: DependencyInput): DependencyDecision {
  const { source, sandbox, current, sandboxHasNodeModules, sourceHasNodeModules } = input

  if (!sandbox) {
    if (source) {
      return {
        action: "error",
        reason: `The sandbox is missing ${source.file}; restore it or create a new sandbox`,
      }
    }
    if (!sandboxHasNodeModules && sourceHasNodeModules) {
      return { action: "link", reason: "No lockfile is present; link the checkout dependencies" }
    }
    return { action: "ready", reason: "No lockfile or dependencies to prepare" }
  }

  if (matchesInstalledState(current, sandbox) && sandboxHasNodeModules) {
    return { action: "ready", reason: "Dependencies match the installed lockfile" }
  }

  if (source && sameLockfile(source, sandbox)) {
    if (sandboxHasNodeModules) {
      return { action: "ready", reason: "Lockfiles match and dependencies are present" }
    }
    if (sourceHasNodeModules) {
      return { action: "link", reason: "Lockfiles match; link the checkout dependencies" }
    }
    return {
      action: "install",
      reason: `Lockfiles match but node_modules is absent; install ${sandbox.manager} dependencies`,
    }
  }

  if (!source && !sandboxHasNodeModules && sourceHasNodeModules) {
    return { action: "link", reason: "The checkout has dependencies but no lockfile" }
  }

  return {
    action: "install",
    reason: source
      ? `The sandbox lockfile (${sandbox.file}) differs from the checkout lockfile (${source.file})`
      : `The checkout has no lockfile; install from the sandbox lockfile (${sandbox.file})`,
  }
}

async function installCommand(
  manager: LabPackageManager,
  root: string,
): Promise<{ manager: string; args: string[] }> {
  if (manager === "npm") {
    return { manager, args: ["ci", "--no-audit", "--no-fund"] }
  }
  if (manager === "pnpm") {
    return { manager, args: ["install", "--frozen-lockfile", "--prefer-offline"] }
  }
  if (manager === "yarn") {
    let berry = false
    try {
      await fs.access(path.join(root, ".yarnrc.yml"))
      berry = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return {
      manager,
      args: berry ? ["install", "--immutable"] : ["install", "--frozen-lockfile"],
    }
  }
  return { manager, args: ["install", "--frozen-lockfile"] }
}

export async function installDependencies(
  root: string,
  lockfile: LockfileState,
): Promise<{ command: string; args: string[]; result: LabProcessResult }> {
  const install = await installCommand(lockfile.manager, root)
  // .cmd shims cannot be spawned directly on Windows; cmd.exe resolves the shim through PATHEXT.
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : install.manager
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", [install.manager, ...install.args].join(" ")]
      : install.args
  const result = await runLabProcess(command, args, {
    cwd: root,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: INSTALL_OUTPUT_LIMIT,
  })
  return { command, args, result }
}

async function removeNodeModulesEntry(root: string): Promise<void> {
  const destination = path.join(root, "node_modules")
  let stat
  try {
    stat = await fs.lstat(destination)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (!stat.isSymbolicLink()) return
  try {
    await fs.unlink(destination)
  } catch (error) {
    if (process.platform !== "win32") throw error
    await fs.rm(destination, { recursive: true, force: true })
  }
}

async function writeDependencyLog(
  reportDir: string,
  command: string,
  args: string[],
  lockfile: LockfileState,
  result: LabProcessResult,
): Promise<string> {
  const logPath = path.join(reportDir, "dependencies.log")
  await ensureDir(reportDir)
  await fs.writeFile(
    logPath,
    [
      `$ ${command} ${args.join(" ")}`,
      `lockfile: ${lockfile.file}`,
      `exit code: ${result.code}`,
      `duration: ${result.durationMs}ms`,
      `timed out: ${result.timedOut}`,
      `aborted: ${result.aborted}`,
      "",
      "--- stdout ---",
      stripAnsi(result.stdout),
      "--- stderr ---",
      stripAnsi(result.stderr),
      "",
    ].join("\n"),
    "utf-8",
  )
  return logPath
}

export async function ensureDependencies(options: EnsureDependenciesOptions): Promise<EnsureDependenciesResult> {
  const [source, sandboxLockfile, sandboxHasNodeModules, sourceHasNodeModules] = await Promise.all([
    readLockfile(options.sandbox.repoRoot),
    readLockfile(options.sandbox.sandboxRoot),
    hasNodeModules(options.sandbox.sandboxRoot),
    hasNodeModules(options.sandbox.repoRoot),
  ])
  const decision = planDependencyAction({
    source,
    sandbox: sandboxLockfile,
    current: options.sandbox.dependencies,
    sandboxHasNodeModules,
    sourceHasNodeModules,
  })

  if (decision.action === "ready") return { sandbox: options.sandbox }
  if (decision.action === "error") throw new Error(decision.reason)

  if (decision.action === "link") {
    const warning = await linkNodeModules(options.sandbox.repoRoot, options.sandbox.sandboxRoot)
    if (!warning) {
      const updated = await updateSandbox(options.projectRoot, options.sandbox.id, {
        dependencies: {
          strategy: "linked",
          lockfile: sandboxLockfile?.file,
          lockHash: sandboxLockfile?.hash,
          manager: sandboxLockfile?.manager,
          updatedAt: new Date().toISOString(),
        },
      })
      if (!updated) throw new Error(`Lab sandbox ${options.sandbox.id} disappeared while linking dependencies`)
      return { sandbox: updated }
    }
  }

  if (!sandboxLockfile) {
    throw new Error(
      `Dependencies cannot be prepared automatically: ${decision.reason}. Install them manually in ${options.sandbox.sandboxRoot}`,
    )
  }

  await removeNodeModulesEntry(options.sandbox.sandboxRoot)
  const installed = await installDependencies(options.sandbox.sandboxRoot, sandboxLockfile)
  const logPath = await writeDependencyLog(
    options.reportDir,
    installed.command,
    installed.args,
    sandboxLockfile,
    installed.result,
  )
  if (installed.result.code !== 0) {
    const detail = outputTail(`${installed.result.stdout}\n${installed.result.stderr}`)
    throw new Error(
      `Dependency install failed with ${installed.command} ${installed.args.join(" ")} in ${options.sandbox.sandboxRoot}${detail ? `: ${detail}` : ""}. See ${logPath}`,
    )
  }
  // npm ci can succeed without creating node_modules when the lockfile has no dependencies.
  await fs.mkdir(path.join(options.sandbox.sandboxRoot, "node_modules"), { recursive: true })

  const updated = await updateSandbox(options.projectRoot, options.sandbox.id, {
    dependencies: {
      strategy: "installed",
      lockfile: sandboxLockfile.file,
      lockHash: sandboxLockfile.hash,
      manager: sandboxLockfile.manager,
      logPath,
      updatedAt: new Date().toISOString(),
    },
  })
  if (!updated) throw new Error(`Lab sandbox ${options.sandbox.id} disappeared while installing dependencies`)
  return {
    sandbox: updated,
    note: `Dependencies installed with ${installed.command} (${sandboxLockfile.file})`,
  }
}
