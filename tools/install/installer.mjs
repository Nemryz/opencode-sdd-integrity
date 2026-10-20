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

// Computes a sha256 checksum of a file's contents, or null if the file doesn't exist.
async function fileChecksum(filePath) {
  try {
    const data = await fs.readFile(filePath)
    return crypto.createHash("sha256").update(data).digest("hex")
  } catch {
    return null
  }
}

// Reads the install manifest if it exists, or null.
export async function readManifest(targetDir) {
  try {
    const raw = await fs.readFile(path.join(targetDir, ".install-manifest.json"), "utf-8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Lists all backups in the target directory, sorted by date (newest first).
export async function listBackups(targetDir) {
  const backupRoot = path.join(targetDir, ".install-backups")
  const exists = await pathExists(backupRoot)
  if (!exists) return []
  const entries = await fs.readdir(backupRoot).catch(() => [])
  const backups = []
  for (const entry of entries) {
    const backupDir = path.join(backupRoot, entry)
    const info = await fs.stat(backupDir).catch(() => null)
    if (!info || !info.isDirectory()) continue
    const files = await fs.readdir(backupDir).catch(() => [])
    const fileCount = files.filter((f) => !f.endsWith(".sha256")).length
    let totalSize = 0
    for (const f of files) {
      const fi = await fs.stat(path.join(backupDir, f)).catch(() => null)
      if (fi) totalSize += fi.size
    }
    // Parse timestamp from stamp: 20261020T215017Z-172f65
    const dateMatch = entry.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/)
    const date = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}`
      : entry
    backups.push({ stamp: entry, dir: backupDir, files: fileCount, size: totalSize, date })
  }
  backups.sort((a, b) => b.stamp.localeCompare(a.stamp))
  return backups
}

// Restores files from a specific backup to the target directory.
// Creates a backup of the current state before restoring.
export async function restoreBackup(targetDir, stamp, { yes = false } = {}) {
  const resolved = path.resolve(targetDir)
  const backupRoot = path.join(resolved, ".install-backups")
  const backupDir = path.join(backupRoot, stamp)
  if (!(await pathExists(backupDir))) {
    throw new Error(`backup not found: ${stamp}`)
  }
  // Create a backup of current state first
  const currentBackup = path.join(backupRoot, backupStamp())
  await fs.mkdir(currentBackup, { recursive: true })
  const currentEntries = await fs.readdir(resolved).catch(() => [])
  for (const entry of currentEntries) {
    if (entry === ".install-backups" || entry.startsWith(".")) continue
    await copyEntry(path.join(resolved, entry), path.join(currentBackup, entry)).catch(() => {})
  }

  // Restore from backup
  const backupEntries = await fs.readdir(backupDir)
  for (const entry of backupEntries) {
    if (entry.endsWith(".sha256")) continue
    await copyEntry(path.join(backupDir, entry), path.join(resolved, entry))
  }
  return { restored: stamp, previousBackup: path.basename(currentBackup) }
}

// Prunes old backups beyond the keep count.
export async function pruneBackups(targetDir, { keep = 10, all = false } = {}) {
  const backups = await listBackups(targetDir)
  if (all) {
    for (const b of backups) {
      await fs.rm(b.dir, { recursive: true, force: true })
    }
    return { removed: backups.length, kept: 0 }
  }
  const toRemove = backups.slice(keep)
  for (const b of toRemove) {
    await fs.rm(b.dir, { recursive: true, force: true })
  }
  return { removed: toRemove.length, kept: Math.min(keep, backups.length) }
}

// Classifies an error and returns a type, message, and suggestion.
export function classifyError(error) {
  const msg = error instanceof Error ? error.message : String(error)
  const code = error && error.code ? error.code : ""
  if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("not found")) {
    return { type: "not-found", message: msg, suggestion: "Install Node.js 22+ from https://nodejs.org and ensure npm is on PATH" }
  }
  if (code === "EACCES" || msg.includes("EACCES") || msg.includes("permission denied")) {
    return { type: "permission", message: msg, suggestion: "Try: sudo npm install -g opencode-sdd-integrity, or use --dir with a writable path" }
  }
  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED") || msg.includes("network")) {
    return { type: "network", message: msg, suggestion: "Check your internet connection and try again" }
  }
  if (code === "ETIMEDOUT" || msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
    return { type: "timeout", message: msg, suggestion: "Download timed out. Try again or use --skip-deps" }
  }
  return { type: "unknown", message: msg, suggestion: "Re-run with --verbose for more details" }
}

// Validates that Node.js version is >= 22.
export function checkNodeVersion() {
  const major = parseInt(process.version.slice(1).split(".")[0], 10)
  if (major < 22) {
    throw new Error(`Node.js ${process.version} is too old. Need >= 22. Upgrade from https://nodejs.org`)
  }
  return major
}

// Writes the install manifest with version, date, and per-file checksums.
async function writeManifest(targetDir, { packageName, packageVersion, copied, checksums }) {
  const manifest = {
    packageName,
    packageVersion,
    installedAt: new Date().toISOString(),
    copied,
    checksums,
  }
  await fs.writeFile(path.join(targetDir, ".install-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8")
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

export async function runInstall({ packageRoot = DEFAULT_PACKAGE_ROOT, targetDir, skipDeps = false, noBackup = false, backup = false, runDeps, onEvent = () => {} } = {}) {
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
  const skipped = []
  const checksums = {}
  for (const item of plan.items) {
    if (!item.available) {
      onEvent({ type: "skip", message: `${item.name} is not shipped by this package` })
      continue
    }
    const sourcePath = path.join(packageRoot, item.name)
    const destPath = path.join(targetDir, item.name)

    // Idempotency: skip files whose content hasn't changed (unless --backup forces re-copy)
    if (item.exists && !backup) {
      const srcHash = await fileChecksum(sourcePath)
      const dstHash = await fileChecksum(destPath)
      if (srcHash && dstHash && srcHash === dstHash) {
        onEvent({ type: "unchanged", message: `${item.name} unchanged, skipped` })
        skipped.push(item.name)
        checksums[item.name] = srcHash
        continue
      }
    }

    // Create backup if file exists (skip if --no-backup; --backup forces backup of existing files)
    if (item.exists && !noBackup) {
      if (!backupDir) {
        backupDir = path.join(targetDir, ".install-backups", backupStamp())
        await fs.mkdir(backupDir, { recursive: true })
      }
      await copyEntry(destPath, path.join(backupDir, item.name))
    }
    await copyEntry(sourcePath, destPath)
    copied.push(item.name)
    checksums[item.name] = await fileChecksum(sourcePath)
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

  // Write install manifest
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf-8"))
  await writeManifest(path.resolve(targetDir), {
    packageName: pkg.name,
    packageVersion: pkg.version,
    copied,
    checksums,
  })

  return {
    targetDir: path.resolve(targetDir),
    backupDir,
    copied,
    skipped,
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

// Diagnoses the health of an installed kit: checks every surface path, dependencies,
// agent discovery, and common misconfigurations, returning actionable suggestions.
export async function doctorInstall({ targetDir, packageRoot = DEFAULT_PACKAGE_ROOT } = {}) {
  if (!targetDir) {
    throw new Error("doctorInstall needs a target directory")
  }
  const resolved = path.resolve(targetDir)
  const surface = await readSurface()
  const checks = []
  const suggestions = []

  // Surface paths
  for (const relPath of surface.verifyPaths) {
    const ok = await pathExists(path.join(resolved, ...relPath.split("/")))
    checks.push({ name: `surface:${relPath}`, ok, message: ok ? "present" : "MISSING" })
    if (!ok) {
      suggestions.push(`Re-run the installer: npx opencode-sdd-integrity install --dir ${resolved} --yes`)
    }
  }

  // Agent discovery
  const agentPath = path.join(resolved, "agents", "spec.md")
  const agentOk = await pathExists(agentPath)
  checks.push({ name: "agent:spec", ok: agentOk, message: agentOk ? "present" : "MISSING (spec agent won't appear in Shift+Tab)" })
  if (!agentOk) {
    suggestions.push(`Copy the spec agent: cp ${packageRoot}/agents/spec.md ${resolved}/agents/spec.md`)
  }

  // Commands
  const commandsDir = path.join(resolved, "commands")
  const commandsExist = await pathExists(commandsDir)
  let commandCount = 0
  if (commandsExist) {
    const entries = await fs.readdir(commandsDir).catch(() => [])
    commandCount = entries.filter((e) => e.endsWith(".md")).length
  }
  const commandsOk = commandCount >= 10
  checks.push({ name: "commands", ok: commandsOk, message: commandsOk ? `${commandCount} commands found` : `only ${commandCount} commands (expected >= 10)` })
  if (!commandsOk) {
    suggestions.push("Re-install the kit to restore missing commands")
  }

  // Skills
  const skillsDir = path.join(resolved, "skills")
  const skillsExist = await pathExists(skillsDir)
  let skillCount = 0
  if (skillsExist) {
    const entries = await fs.readdir(skillsDir).catch(() => [])
    skillCount = entries.filter((e) => !e.startsWith(".")).length
  }
  const skillsOk = skillCount >= 5
  checks.push({ name: "skills", ok: skillsOk, message: skillsOk ? `${skillCount} skills found` : `only ${skillCount} skills (expected >= 5)` })
  if (!skillsOk) {
    suggestions.push("Re-install the kit to restore missing skills")
  }

  // Tools
  const toolsDir = path.join(resolved, "tools")
  const toolsExist = await pathExists(toolsDir)
  let toolCount = 0
  if (toolsExist) {
    const entries = await fs.readdir(toolsDir).catch(() => [])
    toolCount = entries.filter((e) => e.startsWith("speckit-") && e.endsWith(".ts")).length
  }
  const toolsOk = toolCount >= 15
  checks.push({ name: "tools", ok: toolsOk, message: toolsOk ? `${toolCount} tools found` : `only ${toolCount} tools (expected >= 15)` })
  if (!toolsOk) {
    suggestions.push("Re-install the kit to restore missing tools")
  }

  // Plugins
  const pluginsDir = path.join(resolved, "plugins")
  const pluginsExist = await pathExists(pluginsDir)
  let pluginCount = 0
  if (pluginsExist) {
    const entries = await fs.readdir(pluginsDir).catch(() => [])
    pluginCount = entries.filter((e) => e.endsWith(".ts")).length
  }
  const pluginsOk = pluginCount >= 4
  checks.push({ name: "plugins", ok: pluginsOk, message: pluginsOk ? `${pluginCount} plugins found` : `only ${pluginCount} plugins (expected >= 4)` })
  if (!pluginsOk) {
    suggestions.push("Re-install the kit to restore missing plugins")
  }

  // opencode.jsonc validity
  const configPath = path.join(resolved, "opencode.jsonc")
  const configExists = await pathExists(configPath)
  let configValid = false
  if (configExists) {
    try {
      const raw = await fs.readFile(configPath, "utf-8")
      // Strip JSONC comments for parsing (but not // inside strings/URLs)
      const stripped = raw
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/(?<=\s)\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
      JSON.parse(stripped)
      configValid = true
    } catch {
      configValid = false
    }
  }
  checks.push({ name: "config:opencode.jsonc", ok: configValid, message: configValid ? "valid JSONC" : (configExists ? "INVALID JSON" : "MISSING") })
  if (!configValid) {
    suggestions.push(configExists ? "Fix the syntax in opencode.jsonc" : "Run: npx opencode-sdd-integrity install --dir " + resolved + " --yes")
  }

  // Node version
  const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10)
  const nodeOk = nodeMajor >= 22
  checks.push({ name: "node-version", ok: nodeOk, message: nodeOk ? `${process.version}` : `${process.version} (need >= 22)` })
  if (!nodeOk) {
    suggestions.push("Upgrade Node.js to version 22 or later")
  }

  // AGENTS.md
  const agentsMdPath = path.join(resolved, "AGENTS.md")
  const agentsMdOk = await pathExists(agentsMdPath)
  checks.push({ name: "AGENTS.md", ok: agentsMdOk, message: agentsMdOk ? "present" : "MISSING" })
  if (!agentsMdOk) {
    suggestions.push("Re-install the kit to restore AGENTS.md")
  }

  // npm-shrinkwrap.json
  const shrinkwrapPath = path.join(resolved, "npm-shrinkwrap.json")
  const shrinkwrapOk = await pathExists(shrinkwrapPath)
  checks.push({ name: "npm-shrinkwrap.json", ok: shrinkwrapOk, message: shrinkwrapOk ? "present" : "MISSING (dependency lock)" })
  if (!shrinkwrapOk) {
    suggestions.push("Re-install the kit to restore npm-shrinkwrap.json")
  }

  const allOk = checks.every((c) => c.ok)
  // Deduplicate suggestions
  const uniqueSuggestions = [...new Set(suggestions)]
  return {
    targetDir: resolved,
    ok: allOk,
    checks,
    suggestions: uniqueSuggestions.length > 0 ? uniqueSuggestions : ["Installation looks healthy. Run /status in opencode to verify."],
  }
}
