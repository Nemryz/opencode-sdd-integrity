#!/usr/bin/env node
// Command line entry of the published package, offered as `npx opencode-sdd-integrity`.
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import readline from "node:readline/promises"
import { DEFAULT_PACKAGE_ROOT, buildPlan, resolveConfigDir, runInstall, verifyInstall, doctorInstall, listBackups, restoreBackup, pruneBackups, classifyError, checkNodeVersion, readManifest } from "./installer.mjs"

const USAGE = `OpenCode SDD Integrity installer

Usage:
  npx opencode-sdd-integrity install   [--dir <path>] [--skip-deps] [--yes] [--json] [--dry-run] [--no-backup] [--backup] [--verbose]
  npx opencode-sdd-integrity verify    [--dir <path>] [--json]
  npx opencode-sdd-integrity doctor    [--dir <path>] [--json]
  npx opencode-sdd-integrity init      [--dir <path>] [--skip-deps] [--yes] [--json]
  npx opencode-sdd-integrity update    [--dir <path>] [--skip-deps] [--yes] [--json] [--no-backup]
  npx opencode-sdd-integrity backup    list|restore <stamp>|prune [--dir <path>] [--keep N] [--all] [--yes] [--json]
  npx opencode-sdd-integrity --version
  npx opencode-sdd-integrity --help

Commands:
  install   Copy the kit surface into the configuration directory
  verify    Check that all required surface paths are present
  doctor    Diagnose installation health and suggest fixes
  init      First-time setup: install + verify + doctor
  update    Re-install preserving user edits, report skipped/updated
  backup    Manage installation backups (list, restore, prune)

Options:
  --dir <path>   configuration directory, defaults to $XDG_CONFIG_HOME/opencode or ~/.config/opencode
  --skip-deps    copy the files without running npm install
  --yes, -y      skip the confirmation prompt
  --json         print a machine readable result
  --dry-run      show what would be installed without copying anything
  --no-backup    skip backup creation on re-install
  --backup       force backup creation even on first install
  --verbose      print detailed debug output
`

export function parseArgs(argv) {
  const flags = { command: "install", dir: null, skipDeps: false, yes: false, json: false, help: false, version: false, dryRun: false, noBackup: false, backup: false, verbose: false, backupSubcommand: null, backupStamp: null, keep: 10, all: false }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith("-")) {
    flags.command = rest.shift()
    // Handle backup subcommands
    if (flags.command === "backup" && rest[0] && !rest[0].startsWith("-")) {
      flags.backupSubcommand = rest.shift()
      if (flags.backupSubcommand === "restore" && rest[0] && !rest[0].startsWith("-")) {
        flags.backupStamp = rest.shift()
      }
    }
  }
  while (rest.length > 0) {
    const arg = rest.shift()
    switch (arg) {
      case "--dir": {
        if (rest.length === 0) {
          throw new Error("--dir needs a path")
        }
        flags.dir = rest.shift()
        break
      }
      case "--skip-deps":
        flags.skipDeps = true
        break
      case "--yes":
      case "-y":
        flags.yes = true
        break
      case "--json":
        flags.json = true
        break
      case "--dry-run":
        flags.dryRun = true
        break
      case "--no-backup":
        flags.noBackup = true
        break
      case "--backup":
        flags.backup = true
        break
      case "--verbose":
        flags.verbose = true
        break
      case "--keep": {
        if (rest.length === 0) throw new Error("--keep needs a number")
        flags.keep = parseInt(rest.shift(), 10)
        break
      }
      case "--all":
        flags.all = true
        break
      case "--help":
      case "-h":
        flags.help = true
        break
      case "--version":
      case "-v":
        flags.version = true
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }
  return flags
}

async function readVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(DEFAULT_PACKAGE_ROOT, "package.json"), "utf-8"))
  return pkg.version
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))

  // Node version check
  const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10)
  if (nodeMajor < 22 && !flags.help && !flags.version) {
    process.stderr.write(`Error: Node.js ${process.version} is too old. Need >= 22. Upgrade from https://nodejs.org\n`)
    return 1
  }

  if (flags.help || flags.command === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  if (flags.version) {
    process.stdout.write(`${await readVersion()}\n`)
    return 0
  }

  const targetDir = resolveConfigDir({ dir: flags.dir })

  if (flags.command === "verify") {
    const result = await verifyInstall({ targetDir })
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ command: "verify", ...result }, null, 2)}\n`)
    } else {
      const required = result.checks.filter((check) => !check.optional)
      for (const check of result.checks) {
        const label = check.ok ? "PASS" : check.optional ? "INFO" : "FAIL"
        const note = !check.ok && check.optional ? " is optional, the dependency install creates it" : ""
        process.stdout.write(`${label}: ${check.path}${note}\n`)
      }
      const passed = required.filter((check) => check.ok).length
      process.stdout.write(result.ok ? `VERIFY PASSED (${passed}/${required.length} required paths)\n` : `VERIFY FAILED (${required.length - passed} missing)\n`)
    }
    return result.ok ? 0 : 1
  }

  if (flags.command === "doctor") {
    const result = await doctorInstall({ targetDir })
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ command: "doctor", ...result }, null, 2)}\n`)
    } else {
      process.stdout.write(`OpenCode SDD Integrity doctor -> ${result.targetDir}\n`)
      for (const check of result.checks) {
        const label = check.ok ? "PASS" : "FAIL"
        process.stdout.write(`  ${label}: ${check.name} — ${check.message}\n`)
      }
      process.stdout.write(result.ok ? "\nDOCTOR PASSED: installation looks healthy\n" : "\nDOCTOR FAILED: issues found\n")
      if (!result.ok) {
        process.stdout.write("\nSuggestions:\n")
        for (const s of result.suggestions) {
          process.stdout.write(`  - ${s}\n`)
        }
      } else {
        process.stdout.write(`\n${result.suggestions[0]}\n`)
      }
    }
    return result.ok ? 0 : 1
  }

  if (flags.command === "backup") {
    const targetDir = resolveConfigDir({ dir: flags.dir })

    if (flags.backupSubcommand === "list" || !flags.backupSubcommand) {
      const backups = await listBackups(targetDir)
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ command: "backup", subcommand: "list", targetDir, backups }, null, 2)}\n`)
      } else {
        if (backups.length === 0) {
          process.stdout.write(`No backups found in ${targetDir}/.install-backups\n`)
        } else {
          process.stdout.write(`Backups in ${targetDir}/.install-backups:\n`)
          for (const b of backups) {
            const sizeKb = (b.size / 1024).toFixed(1)
            process.stdout.write(`  ${b.stamp}  ${b.date}  ${b.files} files  ${sizeKb} KB\n`)
          }
        }
      }
      return 0
    }

    if (flags.backupSubcommand === "restore") {
      if (!flags.backupStamp) {
        process.stderr.write("Error: backup restore needs a stamp. Use 'backup list' to see available stamps.\n")
        return 1
      }
      if (!flags.yes && !flags.json) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = (await rl.question(`Restore backup ${flags.backupStamp}? This will overwrite current files. [y/N] `)).trim().toLowerCase()
        rl.close()
        if (answer !== "y" && answer !== "yes") {
          process.stdout.write("Aborted.\n")
          return 0
        }
      }
      const result = await restoreBackup(targetDir, flags.backupStamp, { yes: flags.yes })
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ command: "backup", subcommand: "restore", ...result }, null, 2)}\n`)
      } else {
        process.stdout.write(`Restored from ${result.restored}. Previous state saved to ${result.previousBackup}.\n`)
      }
      return 0
    }

    if (flags.backupSubcommand === "prune") {
      const result = await pruneBackups(targetDir, { keep: flags.keep, all: flags.all })
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ command: "backup", subcommand: "prune", ...result }, null, 2)}\n`)
      } else {
        process.stdout.write(`Pruned ${result.removed} backup(s), ${result.kept} kept.\n`)
      }
      return 0
    }

    process.stderr.write(`Unknown backup subcommand: ${flags.backupSubcommand}. Use 'list', 'restore <stamp>', or 'prune'.\n`)
    return 1
  }

  if (flags.command === "init") {
    // First-time setup: install + verify + doctor
    const plan = await buildPlan({ targetDir })
    const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !flags.yes && !flags.json
    if (!flags.json) {
      process.stdout.write(`OpenCode SDD Integrity init -> ${targetDir}\n`)
      process.stdout.write("==> Step 1/3: Installing files...\n")
    }
    if (interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = (await rl.question("Proceed? [Y/n] ")).trim().toLowerCase()
      rl.close()
      if (answer !== "" && answer !== "y" && answer !== "yes") {
        process.stdout.write("Aborted.\n")
        return 0
      }
    }
    const result = await runInstall({
      targetDir,
      skipDeps: flags.skipDeps,
      noBackup: flags.noBackup,
      backup: flags.backup,
      onEvent: (event) => {
        if (!flags.json) {
          process.stdout.write(`    ${event.message}\n`)
        }
        if (flags.verbose) {
          process.stderr.write(`    [verbose] event: ${JSON.stringify(event)}\n`)
        }
      },
    })
    if (!flags.json) {
      process.stdout.write("==> Step 2/3: Verifying...\n")
    }
    const verification = await verifyInstall({ targetDir })
    if (!flags.json) {
      const required = verification.checks.filter((check) => !check.optional)
      const passed = required.filter((check) => check.ok).length
      process.stdout.write(`    ${passed}/${required.length} required paths present\n`)
      process.stdout.write("==> Step 3/3: Running doctor...\n")
    }
    const doctor = await doctorInstall({ targetDir })
    if (!flags.json) {
      process.stdout.write(doctor.ok ? "    DOCTOR PASSED\n" : "    DOCTOR FAILED\n")
      process.stdout.write(`\n==> Done! ${plan.packageName} initialized at ${result.targetDir}\n`)
      process.stdout.write("    Next steps:\n")
      process.stdout.write("    1. Restart opencode and run /status to verify\n")
      process.stdout.write("    2. Use Shift+Tab to switch to the 'spec' agent\n")
      process.stdout.write("    3. Run /spec <description> to start a new feature\n")
    }
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ command: "init", packageName: plan.packageName, packageVersion: plan.packageVersion, ...result, verification, doctor }, null, 2)}\n`)
    }
    return (result.verification.ok && doctor.ok) ? 0 : 1
  }

  if (flags.command === "update") {
    const manifest = await (await import("./installer.mjs")).readManifest(targetDir)
    const plan = await buildPlan({ targetDir })
    if (!flags.json) {
      process.stdout.write(`OpenCode SDD Integrity update -> ${targetDir}\n`)
      if (manifest) {
        process.stdout.write(`  Installed version: ${manifest.packageVersion}, package version: ${plan.packageVersion}\n`)
        if (manifest.packageVersion === plan.packageVersion) {
          process.stdout.write("  Already up to date.\n")
        }
      } else {
        process.stdout.write("  No previous install manifest found, performing full install.\n")
      }
      process.stdout.write("==> Updating files...\n")
    }
    const result = await runInstall({
      targetDir,
      skipDeps: flags.skipDeps,
      noBackup: flags.noBackup,
      backup: flags.backup,
      onEvent: (event) => {
        if (!flags.json) {
          process.stdout.write(`    ${event.message}\n`)
        }
      },
    })
    if (!flags.json) {
      const required = result.verification.checks.filter((check) => !check.optional)
      const passed = required.filter((check) => check.ok).length
      process.stdout.write(`==> Verify: ${passed}/${required.length} required paths present\n`)
      process.stdout.write(`==> Done! ${plan.packageName} updated at ${result.targetDir}\n`)
      if (result.skipped && result.skipped.length > 0) {
        process.stdout.write(`    ${result.skipped.length} file(s) unchanged, skipped\n`)
      }
      if (result.copied && result.copied.length > 0) {
        process.stdout.write(`    ${result.copied.length} file(s) updated\n`)
      }
    }
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ command: "update", packageName: plan.packageName, packageVersion: plan.packageVersion, ...result }, null, 2)}\n`)
    }
    return result.verification.ok ? 0 : 1
  }

  if (flags.command !== "install") {
    throw new Error(`unknown command: ${flags.command}`)
  }

  const plan = await buildPlan({ targetDir })
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !flags.yes && !flags.json

  if (!flags.json) {
    process.stdout.write(`OpenCode SDD Integrity ${plan.packageVersion} -> ${plan.targetDir}\n`)
    if (interactive) {
      process.stdout.write("The installer copies the kit files and saves the previous copies in .install-backups.\n")
    }
  }
  // Dry run: show what would be installed without copying anything
  if (flags.dryRun) {
    if (!flags.json) {
      process.stdout.write("\n==> Dry run (no files will be copied)\n")
      const surface = await (await import("./installer.mjs")).readSurface()
      for (const item of plan.items) {
        const status = item.exists ? "exists" : "new"
        const avail = item.available ? "" : " (NOT SHIPPED)"
        process.stdout.write(`    ${item.kind === "dir" ? "DIR " : "FILE"} ${item.name} [${status}]${avail}\n`)
      }
      process.stdout.write(`    ${plan.example.needed ? "NEW " : "KEEP"} ${surface.exampleFile.target}\n`)
      process.stdout.write(`\n==> ${plan.items.filter(i => i.available).length} items would be copied\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ command: "install", dryRun: true, items: plan.items, example: plan.example }, null, 2)}\n`)
    }
    return 0
  }

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question("Proceed? [Y/n] ")).trim().toLowerCase()
    rl.close()
    if (answer !== "" && answer !== "y" && answer !== "yes") {
      process.stdout.write("Aborted.\n")
      return 0
    }
  }

  if (!flags.json) {
    process.stdout.write("==> Installing files...\n")
  }
  const result = await runInstall({
    targetDir,
    skipDeps: flags.skipDeps,
    noBackup: flags.noBackup,
    backup: flags.backup,
    onEvent: (event) => {
      if (!flags.json) {
        process.stdout.write(`    ${event.message}\n`)
      }
      if (flags.verbose) {
        process.stderr.write(`    [verbose] event: ${JSON.stringify(event)}\n`)
      }
    },
  })

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ command: "install", packageName: plan.packageName, packageVersion: plan.packageVersion, ...result }, null, 2)}\n`)
  } else {
    const required = result.verification.checks.filter((check) => !check.optional)
    const passed = required.filter((check) => check.ok).length
    process.stdout.write(`==> Verify: ${passed}/${required.length} required paths present\n`)
    process.stdout.write(`==> Done! ${plan.packageName} installed to ${result.targetDir}\n`)
    process.stdout.write("    Restart opencode and run /status to verify.\n")
  }
  return result.verification.ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const classified = classifyError(error)
    process.stderr.write(`Error [${classified.type}]: ${classified.message}\n`)
    process.stderr.write(`Suggestion: ${classified.suggestion}\n`)
    process.exitCode = 1
  })
