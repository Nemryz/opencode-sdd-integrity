// Installs the kit surface into an opencode configuration directory without git.
// The module is plain ESM so the published package runs it straight from npm, with no build step.
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..")
export const SURFACE_FILE = path.join(MODULE_DIR, "surface.json")

export async function readSurface(surfaceFile = SURFACE_FILE) {
  return JSON.parse(await fs.readFile(surfaceFile, "utf-8"))
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

// Keeps the tilde shorthand working when a caller passes "~/.config/opencode" as a flag value.
export function resolveConfigDir({ dir, env = process.env, home = os.homedir() } = {}) {
  if (dir && dir.startsWith("~")) {
    return path.join(home, dir.slice(1).replace(/^[\\/]/, ""))
  }
  if (dir) {
    return path.resolve(dir)
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg) {
    return path.join(xdg, "opencode")
  }
  return path.join(home, ".config", "opencode")
}

function assertSafeTarget(targetDir, packageRoot) {
  const resolved = path.resolve(targetDir)
  const root = path.parse(resolved).root
  if (resolved === root) {
    throw new Error(`refusing to install into the filesystem root: ${resolved}`)
  }
  if (resolved === path.resolve(os.homedir())) {
    throw new Error(`refusing to install into the home directory itself: ${resolved}`)
  }
  if (resolved === path.resolve(packageRoot)) {
    throw new Error(`refusing to install into the package directory itself: ${resolved}`)
  }
}

// Copies files and whole trees entry by entry, because fs.cp grows surprising merge rules on existing destinations.
async function copyEntry(source, dest) {
  const info = await fs.stat(source)
  if (info.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(source)
    for (const entry of entries) {
      await copyEntry(path.join(source, entry), path.join(dest, entry))
    }
    return
  }
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(source, dest)
}

function backupStamp() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`
}

export async function buildPlan({ packageRoot = DEFAULT_PACKAGE_ROOT, targetDir } = {}) {
  if (!targetDir) {
    throw new Error("buildPlan needs a target directory")
  }
  const surface = await readSurface()
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf-8"))
  const items = []
  for (const name of [...surface.copyFiles, ...surface.copyDirs]) {
    items.push({
      name,
      kind: surface.copyDirs.includes(name) ? "dir" : "file",
      exists: await pathExists(path.join(targetDir, name)),
      available: await pathExists(path.join(packageRoot, name)),
    })
  }
  const exampleTarget = path.join(targetDir, surface.exampleFile.target)
  return {
    packageName: pkg.name,
    packageVersion: pkg.version,
    targetDir: path.resolve(targetDir),
    items,
    example: {
      source: path.join(packageRoot, surface.exampleFile.source),
      target: exampleTarget,
      needed: !(await pathExists(exampleTarget)),
    },
  }
}

export async function runInstall({ packageRoot = DEFAULT_PACKAGE_ROOT, targetDir, skipDeps = false, runDeps, onEvent = () => {} } = {}) {
  if (!targetDir) {
    throw new Error("runInstall needs a target directory")
  }
  assertSafeTarget(targetDir, packageRoot)
  const existing = await fs.stat(targetDir).catch(() => null)
  if (existing && !existing.isDirectory()) {
    throw new Error(`refusing to install into a file: ${targetDir}`)
  }

  const surface = await readSurface()
  const plan = await buildPlan({ packageRoot, targetDir })
  await fs.mkdir(targetDir, { recursive: true })

  let backupDir = null
  const copied = []
  for (const item of plan.items) {
    if (!item.available) {
      onEvent({ type: "skip", message: `${item.name} is not shipped by this package` })
      continue
    }
    if (item.exists) {
      if (!backupDir) {
        backupDir = path.join(targetDir, ".install-backups", backupStamp())
        await fs.mkdir(backupDir, { recursive: true })
      }
      await copyEntry(path.join(targetDir, item.name), path.join(backupDir, item.name))
    }
    await copyEntry(path.join(packageRoot, item.name), path.join(targetDir, item.name))
    copied.push(item.name)
  }
  if (backupDir) {
    onEvent({ type: "backup", message: `previous files saved to ${backupDir}` })
  }

  let exampleCreated = false
  if (plan.example.needed && (await pathExists(plan.example.source))) {
    await fs.copyFile(plan.example.source, plan.example.target)
    exampleCreated = true
    onEvent({ type: "example", message: `created ${surface.exampleFile.target}` })
  } else {
    onEvent({ type: "example", message: `${surface.exampleFile.target} already exists, kept as is` })
  }

  let deps = "skipped"
  if (!skipDeps) {
    onEvent({ type: "deps", message: "installing runtime dependencies" })
    const installDeps = runDeps ?? spawnNpmInstall
    try {
      await installDeps(targetDir)
      deps = "installed"
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${reason}. Run it manually: cd ${targetDir} && npm install --ignore-scripts --omit=dev`)
    }
  }

  const verification = await verifyInstall({ targetDir, surface })
  return {
    targetDir: path.resolve(targetDir),
    backupDir,
    copied,
    exampleCreated,
    deps,
    verification,
  }
}

function spawnNpmInstall(cwd) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm"
  const args = ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    })
    child.on("error", (error) => reject(new Error(`could not start npm: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`npm install exited with code ${code}`))
      }
    })
  })
}

export async function verifyInstall({ targetDir, surface } = {}) {
  if (!targetDir) {
    throw new Error("verifyInstall needs a target directory")
  }
  const loaded = surface ?? (await readSurface())
  const checks = []
  for (const relPath of loaded.verifyPaths) {
    checks.push({ path: relPath, ok: await pathExists(path.join(targetDir, ...relPath.split("/"))), optional: false })
  }
  for (const relPath of loaded.optionalPaths) {
    checks.push({ path: relPath, ok: await pathExists(path.join(targetDir, ...relPath.split("/"))), optional: true })
  }
  return {
    targetDir: path.resolve(targetDir),
    ok: checks.every((check) => check.ok || check.optional),
    checks,
  }
}
