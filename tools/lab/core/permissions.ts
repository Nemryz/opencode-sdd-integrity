import fs from "node:fs/promises"
import path from "node:path"
import { runLabProcess } from "./runner"

const LAB_DIRECTORY_MODE = 0o700
const USABLE_FLAG = fs.constants.X_OK | fs.constants.R_OK

// Applies the expected permission to a single directory, so a sandbox tree stays outside other users.
export async function prepareSandboxPermissions(absoluteDir: string): Promise<void> {
  let stat
  try {
    stat = await fs.lstat(absoluteDir)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      await fs.mkdir(path.dirname(absoluteDir), { recursive: true })
      await fs.mkdir(absoluteDir, { recursive: true })
      stat = await fs.lstat(absoluteDir)
    } else {
      throw error
    }
  }
  if (stat?.isDirectory()) {
    const probe = path.join(absoluteDir, ".opencode-lab-permission-probe")
    await fs.writeFile(probe, "", "utf-8")
    await fs.rm(probe, { force: true })
    await fs.chmod(absoluteDir, LAB_DIRECTORY_MODE)
    await verifyDirectoryUsable(absoluteDir, true)
  }
}

// Refuses a target that is not a directory, cannot be executed and read or misses one of those rights.
export async function verifyDirectoryUsable(dir: string, writable: boolean): Promise<void> {
  const stat = await fs.stat(dir)
  if (!stat.isDirectory()) throw new Error(`The lab cannot use a non directory path: ${dir}`)
  const required = writable ? fs.constants.W_OK | fs.constants.X_OK : fs.constants.R_OK | fs.constants.X_OK
  try {
    await fs.access(dir, required)
  } catch {
    throw new Error(`The lab needs an executable${writable ? " and writable" : " and readable"} directory: ${dir}`)
  }
}

export const DISABLED_HOOKS_DIR = ".opencode-lab-disabled-hooks"

// A worktree may share its git dir with the checkout, so point hook execution at an absent local path.
export async function disableSandboxHooks(sandboxRoot: string): Promise<boolean> {
  const result = await runLabProcess("git", ["config", "--local", "core.hooksPath", DISABLED_HOOKS_DIR], {
    cwd: sandboxRoot,
    timeoutMs: 10_000,
  })
  return result.code === 0
}
