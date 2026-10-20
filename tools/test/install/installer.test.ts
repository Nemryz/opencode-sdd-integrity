import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { buildPlan, readSurface, resolveConfigDir, runInstall, verifyInstall } from "../../install/installer.mjs"
import { removeDirWithRetry, repoRootDir } from "../helpers/setup"

const execFileAsync = promisify(execFile)
const REPO_ROOT = repoRootDir()
const CLI = path.join(REPO_ROOT, "tools", "install", "cli.mjs")

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-install-"))
  tempDirs.push(dir)
  return dir
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false)
}

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], env?: Record<string, string>): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

function npmCommand(): { command: string; shell: boolean } {
  return process.platform === "win32" ? { command: "npm.cmd", shell: true } : { command: "npm", shell: false }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeDirWithRetry(dir)))
})

describe("resolveConfigDir", () => {
  const home = path.join(os.tmpdir(), "sdd-home")

  it("uses an explicit directory over the environment", () => {
    const explicit = path.join(os.tmpdir(), "sdd-explicit")
    expect(resolveConfigDir({ dir: explicit, env: { XDG_CONFIG_HOME: "/xdg" }, home })).toBe(path.resolve(explicit))
  })

  it("resolves relative directories against the current directory", () => {
    expect(resolveConfigDir({ dir: "sdd-relative", env: {}, home })).toBe(path.resolve("sdd-relative"))
  })

  it("expands the tilde shorthand", () => {
    expect(resolveConfigDir({ dir: "~/.config/opencode", env: {}, home })).toBe(path.join(home, ".config", "opencode"))
  })

  it("uses XDG_CONFIG_HOME when it is set", () => {
    const xdg = path.join(os.tmpdir(), "sdd-xdg")
    expect(resolveConfigDir({ env: { XDG_CONFIG_HOME: xdg }, home })).toBe(path.join(xdg, "opencode"))
  })

  it("falls back to the home config directory", () => {
    expect(resolveConfigDir({ env: {}, home })).toBe(path.join(home, ".config", "opencode"))
  })

  it("ignores an empty XDG_CONFIG_HOME", () => {
    expect(resolveConfigDir({ env: { XDG_CONFIG_HOME: "" }, home })).toBe(path.join(home, ".config", "opencode"))
  })
})

describe("surface contract", () => {
  it("the verify scripts check exactly the surface required and optional paths", async () => {
    const surface = await readSurface()
    const expected = [...surface.verifyPaths, ...surface.optionalPaths]
    const shell = await fs.readFile(path.join(REPO_ROOT, "tools", "test", "install", "verify-install.sh"), "utf-8")
    const shellPaths = shell.split("\n").filter((line) => line.startsWith("expect_path ")).map((line) => line.slice("expect_path ".length).trim())
    expect(shellPaths).toEqual(expected)

    const powershell = await fs.readFile(path.join(REPO_ROOT, "tools", "test", "install", "verify-install.ps1"), "utf-8")
    const powershellPaths = powershell.split("\n").filter((line) => line.startsWith("Expect-Path ")).map((line) => line.slice("Expect-Path ".length).trim().replace(/^"|"$/g, ""))
    expect(powershellPaths).toEqual(expected)
  })

  it("the surface ships the shrinkwrap lock file as a required path, because npm pack keeps it", async () => {
    const surface = await readSurface()
    expect(surface.copyFiles).toContain("npm-shrinkwrap.json")
    expect(surface.verifyPaths).toContain("npm-shrinkwrap.json")
    expect(surface.optionalPaths).toEqual([])
  })

  it("the shell installer copies exactly the surface copy sets", async () => {
    const surface = await readSurface()
    const expected = new Set([...surface.copyFiles, ...surface.copyDirs, surface.exampleFile.source])
    const shell = await fs.readFile(path.join(REPO_ROOT, "install.sh"), "utf-8")
    const copied = new Set<string>()
    for (const line of shell.split("\n").filter((line) => /^\s*cp\b/.test(line))) {
      const match = line.match(/opencode-sdd-integrity[\\/]([\w.-]+)/)
      if (match) copied.add(match[1])
    }
    expect(copied).toEqual(expected)
  })

  it("the PowerShell installer copies exactly the surface copy sets", async () => {
    const surface = await readSurface()
    const expected = new Set([...surface.copyFiles, ...surface.copyDirs, surface.exampleFile.source])
    const powershell = await fs.readFile(path.join(REPO_ROOT, "install.ps1"), "utf-8")
    const copied = new Set<string>()
    for (const match of powershell.matchAll(/Join-Path \$CloneDir "([^"]+)"/g)) {
      copied.add(match[1])
    }
    expect(copied).toEqual(expected)
  })
})

describe("buildPlan", () => {
  it("describes the shipped surface and the example config", async () => {
    const target = await makeTempDir()
    const surface = await readSurface()
    const plan = await buildPlan({ packageRoot: REPO_ROOT, targetDir: target })

    expect(plan.packageName).toBe("opencode-sdd-integrity")
    expect(plan.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(plan.items.map((item) => item.name)).toEqual([...surface.copyFiles, ...surface.copyDirs])
    expect(plan.items.every((item) => item.available)).toBe(true)
    expect(plan.items.every((item) => !item.exists)).toBe(true)
    expect(plan.example.needed).toBe(true)
  })

  it("stops asking for the example config once it exists", async () => {
    const target = await makeTempDir()
    await fs.writeFile(path.join(target, "opencode.jsonc"), "// mine\n", "utf-8")
    const plan = await buildPlan({ packageRoot: REPO_ROOT, targetDir: target })
    expect(plan.example.needed).toBe(false)
  })
})

describe("install lifecycle", () => {
  it("copies the full surface into a fresh directory", async () => {
    const target = await fs.mkdtemp(path.join(await makeTempDir(), "fresh-"))
    const surface = await readSurface()
    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })

    expect(result.backupDir).toBeNull()
    expect(result.exampleCreated).toBe(true)
    expect(result.deps).toBe("skipped")
    expect(result.verification.ok).toBe(true)
    expect(result.copied).toEqual(expect.arrayContaining([...surface.copyFiles, ...surface.copyDirs]))
    for (const relPath of surface.verifyPaths) {
      expect(await exists(path.join(target, ...relPath.split("/"))), `missing after install: ${relPath}`).toBe(true)
    }
    expect(await exists(path.join(target, "npm-shrinkwrap.json"))).toBe(true)
  })

  it("installs into a directory whose name carries spaces", async () => {
    const target = path.join(await makeTempDir(), "my kit dir")
    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    expect(result.verification.ok).toBe(true)
  })

  it("backs up replaced files, refreshes them and keeps the user config", async () => {
    const target = path.join(await makeTempDir(), "reinstall")
    await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })
    await fs.appendFile(path.join(target, "AGENTS.md"), "\n<!-- user edit -->\n")
    await fs.appendFile(path.join(target, "opencode.jsonc"), "\n// user config\n")

    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })

    expect(result.backupDir).not.toBeNull()
    const backupName = path.basename(result.backupDir ?? "")
    expect(backupName).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    const backups = await fs.readdir(path.join(target, ".install-backups"))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(result.backupDir ?? "", "AGENTS.md"), "utf-8")).toContain("user edit")
    expect(await fs.readFile(path.join(target, "AGENTS.md"), "utf-8")).not.toContain("user edit")
    expect(await fs.readFile(path.join(target, "opencode.jsonc"), "utf-8")).toContain("user config")
    expect(result.exampleCreated).toBe(false)
  })

  it("reports the dependencies as installed when the runner succeeds", async () => {
    const target = await makeTempDir()
    const result = await runInstall({ packageRoot: REPO_ROOT, targetDir: target, runDeps: async () => {} })
    expect(result.deps).toBe("installed")
  })

  it("fails loudly with the manual command when npm install fails", async () => {
    const target = await makeTempDir()
    const failing = runInstall({
      packageRoot: REPO_ROOT,
      targetDir: target,
      runDeps: async () => {
        throw new Error("npm install exited with code 7")
      },
    })
    await expect(failing).rejects.toThrow(/npm install exited with code 7.*Run it manually/s)
  })

  it("refuses the filesystem root, the home directory and the package directory", async () => {
    await expect(runInstall({ packageRoot: REPO_ROOT, targetDir: path.parse(REPO_ROOT).root, skipDeps: true })).rejects.toThrow(/filesystem root/)
    await expect(runInstall({ packageRoot: REPO_ROOT, targetDir: os.homedir(), skipDeps: true })).rejects.toThrow(/home directory/)
    await expect(runInstall({ packageRoot: REPO_ROOT, targetDir: REPO_ROOT, skipDeps: true })).rejects.toThrow(/package directory/)
  })

  it("refuses a target that is an existing file", async () => {
    const holder = await makeTempDir()
    const target = path.join(holder, "target-file")
    await fs.writeFile(target, "not a directory", "utf-8")
    await expect(runInstall({ packageRoot: REPO_ROOT, targetDir: target, skipDeps: true })).rejects.toThrow(/refusing to install into a file/)
  })
})

describe("verifyInstall", () => {
  it("fails with the list of missing paths on an empty directory", async () => {
    const target = await makeTempDir()
    const result = await verifyInstall({ targetDir: target })
    expect(result.ok).toBe(false)
    expect(result.checks.every((check) => check.ok)).toBe(false)
  })

  it("reports a missing optional path without failing", async () => {
    const target = await makeTempDir()
    const surface = {
      copyFiles: [],
      copyDirs: [],
      exampleFile: { source: "example.json", target: "opencode.jsonc" },
      verifyPaths: [],
      optionalPaths: ["npm-shrinkwrap.json"],
    }
    const result = await verifyInstall({ targetDir: target, surface })
    const lock = result.checks.find((check) => check.path === "npm-shrinkwrap.json")
    expect(result.ok).toBe(true)
    expect(lock?.optional).toBe(true)
    expect(lock?.ok).toBe(false)
  })
})

describe("cli", () => {
  it("installs and verifies in json mode", async () => {
    const target = await makeTempDir()
    const install = await runCli(["install", "--dir", target, "--skip-deps", "--json"])
    expect(install.stderr).toBe("")
    expect(install.code).toBe(0)
    const parsed = JSON.parse(install.stdout) as { command: string; verification: { ok: boolean } }
    expect(parsed.command).toBe("install")
    expect(parsed.verification.ok).toBe(true)

    const verify = await runCli(["verify", "--dir", target])
    expect(verify.code).toBe(0)
    expect(verify.stdout).toContain("VERIFY PASSED")
  })

  it("fails verification on an empty directory", async () => {
    const target = await makeTempDir()
    const verify = await runCli(["verify", "--dir", target])
    expect(verify.code).toBe(1)
    expect(verify.stdout).toContain("VERIFY FAILED")
  })

  it("prints help and version without touching the disk", async () => {
    const help = await runCli(["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("npx opencode-sdd-integrity install")

    const version = await runCli(["--version"])
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("rejects unknown options and unknown commands", async () => {
    const option = await runCli(["install", "--nope"])
    expect(option.code).toBe(1)
    expect(option.stderr).toContain("unknown option: --nope")

    const command = await runCli(["frobnicate"])
    expect(command.code).toBe(1)
    expect(command.stderr).toContain("unknown command: frobnicate")
  })

  it("resolves the default directory from XDG_CONFIG_HOME", async () => {
    const root = await makeTempDir()
    const install = await runCli(["install", "--skip-deps", "--json"], { XDG_CONFIG_HOME: root })
    expect(install.code).toBe(0)
    const parsed = JSON.parse(install.stdout) as { targetDir: string }
    expect(parsed.targetDir).toBe(path.join(root, "opencode"))
  })

  it.skipIf(process.platform === "win32")("runs through its shebang like the published bin", async () => {
    const { stdout } = await execFileAsync(CLI, ["--version"], { encoding: "utf-8" })
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("doctor reports healthy on a fresh install", async () => {
    const target = await makeTempDir()
    await runCli(["install", "--dir", target, "--skip-deps", "--yes"])
    const doctor = await runCli(["doctor", "--dir", target])
    expect(doctor.code).toBe(0)
    expect(doctor.stdout).toContain("DOCTOR PASSED")
  })

  it("doctor reports failures on an empty directory", async () => {
    const target = await makeTempDir()
    const doctor = await runCli(["doctor", "--dir", target])
    expect(doctor.code).toBe(1)
    expect(doctor.stdout).toContain("DOCTOR FAILED")
  })

  it("doctor outputs valid json", async () => {
    const target = await makeTempDir()
    await runCli(["install", "--dir", target, "--skip-deps", "--yes"])
    const doctor = await runCli(["doctor", "--dir", target, "--json"])
    expect(doctor.code).toBe(0)
    const parsed = JSON.parse(doctor.stdout) as { command: string; ok: boolean; checks: unknown[] }
    expect(parsed.command).toBe("doctor")
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.length).toBeGreaterThan(0)
  })

  it("dry-run does not copy any files", async () => {
    const target = await makeTempDir()
    const dryRun = await runCli(["install", "--dir", target, "--dry-run", "--yes"])
    expect(dryRun.code).toBe(0)
    expect(dryRun.stdout).toContain("Dry run")
    expect(dryRun.stdout).toContain("would be copied")
    // No files should be copied
    const fileExists = await exists(path.join(target, "AGENTS.md"))
    expect(fileExists).toBe(false)
  })

  it("init performs install + verify + doctor", async () => {
    const target = await makeTempDir()
    const init = await runCli(["init", "--dir", target, "--skip-deps", "--yes"])
    expect(init.code).toBe(0)
    expect(init.stdout).toContain("Step 1/3")
    expect(init.stdout).toContain("Step 2/3")
    expect(init.stdout).toContain("Step 3/3")
    expect(init.stdout).toContain("DOCTOR PASSED")
    expect(init.stdout).toContain("Next steps:")
  })

  it("update detects unchanged files and skips them", async () => {
    const target = await makeTempDir()
    await runCli(["install", "--dir", target, "--skip-deps", "--yes"])
    const update = await runCli(["update", "--dir", target, "--skip-deps", "--yes"])
    expect(update.code).toBe(0)
    expect(update.stdout).toContain("unchanged, skipped")
  })

  it("no-backup flag skips backup creation", async () => {
    const target = await makeTempDir()
    await runCli(["install", "--dir", target, "--skip-deps", "--yes"])
    const update = await runCli(["install", "--dir", target, "--skip-deps", "--yes", "--no-backup"])
    expect(update.code).toBe(0)
    // No backup directory should be created on second install
    const backupExists = await exists(path.join(target, ".install-backups"))
    // Backups from first install exist, but no new ones from no-backup
    expect(update.stdout).not.toContain("previous files saved")
  })

  it("the packed tarball ships the installer entry and its surface", async () => {
    const { command, shell } = npmCommand()
    const { stdout } = await execFileAsync(command, ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      shell,
    })
    const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
    const files = pack.files.map((entry) => entry.path)
    expect(files).toContain("tools/install/cli.mjs")
    expect(files).toContain("tools/install/installer.mjs")
    expect(files).toContain("tools/install/surface.json")
  })
})
