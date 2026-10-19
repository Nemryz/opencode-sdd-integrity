import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { ownedRepoFiles, repoRootDir } from "../helpers/setup"

const REPO_ROOT = repoRootDir()

const KIT_COMMANDS = [
  "approve",
  "audit",
  "baseline",
  "clean",
  "config",
  "delta-status",
  "guard",
  "health",
  "impl",
  "matrix",
  "plan",
  "review",
  "snapshot",
  "spec",
  "status",
  "steering",
  "tasks",
]

// agents/novel.md is intentionally untracked (personal agent), spec.md is the only shipped one
const KIT_AGENTS = ["spec"]

async function readRepoFile(relPath: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, ...relPath.split("/")), "utf-8")
}

async function existsInRepo(relPath: string): Promise<boolean> {
  return fs.stat(path.join(REPO_ROOT, ...relPath.split("/"))).then(() => true).catch(() => false)
}

async function readPkgName(): Promise<string> {
  const pkg = JSON.parse(await readRepoFile("package.json")) as { name: string }
  return pkg.name
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Repo hygiene checks only make sense inside a git checkout because they rely on the tracked file list.
const hasGit = ownedRepoFiles().size > 0

function trackedUnder(prefix: string): string[] {
  return [...ownedRepoFiles()].filter((file) => file.startsWith(prefix)).sort()
}

describe("repo hygiene: local plugin content must stay untracked", () => {
  it.skipIf(!hasGit)("tracks only kit commands", () => {
    for (const file of trackedUnder("commands/")) {
      const name = file.replace("commands/", "").replace(/\.md$/, "")
      expect(KIT_COMMANDS, `unexpected command tracked: ${file}`).toContain(name)
    }
  })

  it.skipIf(!hasGit)("tracks only kit agents", () => {
    for (const file of trackedUnder("agents/")) {
      const name = file.replace("agents/", "").replace(/\.md$/, "")
      expect(KIT_AGENTS, `unexpected agent tracked: ${file}`).toContain(name)
    }
  })

  it.skipIf(!hasGit)("tracks only kit skills", () => {
    for (const file of trackedUnder("skills/")) {
      const skillDir = file.split("/")[1]
      const isKitSkill = skillDir === "rules" || skillDir.startsWith("speckit-")
      expect(isKitSkill, `unexpected skill tracked: ${file}`).toBe(true)
    }
  })

  it.skipIf(!hasGit)("does not track local-only config, MCP servers or plugin scripts", () => {
    const tracked = [...ownedRepoFiles()]
    const forbidden = [
      /^opencode\.jsonc$/,
      /^mcp-servers\//,
      /^scripts\//,
      /^experiments\//,
      /^gold\//,
      /^plantilla-anki\//,
      /^\.engram-/,
      /^VISION-/,
      /^PATCHES-/,
      /^docs\/\d{2}-/,
    ]
    for (const file of tracked) {
      for (const pattern of forbidden) {
        expect(pattern.test(file), `local-only path is tracked: ${file}`).toBe(false)
      }
    }
  })
})

describe("shipped surface stays consistent", () => {
  it("every path in the release archive exists", async () => {
    const workflow = await readRepoFile(".github/workflows/release.yml")
    const tarIndex = workflow.indexOf("tar czf")
    expect(tarIndex).toBeGreaterThan(-1)

    const lines = workflow.slice(tarIndex).split("\n")
    const paths: string[] = []
    let started = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!started) {
        if (trimmed.startsWith("tar czf")) started = true
        continue
      }
      if (!trimmed.endsWith("\\")) break
      paths.push(...trimmed.replace(/\\\s*$/, "").split(/\s+/).filter(Boolean))
    }

    expect(paths.length).toBeGreaterThan(0)
    for (const relPath of paths.filter(Boolean)) {
      expect(await existsInRepo(relPath), `release archive path missing: ${relPath}`).toBe(true)
    }
  })

  it("every stryker mutate path exists", async () => {
    const config = JSON.parse(await readRepoFile("stryker.conf.json")) as { mutate: string[] }
    expect(config.mutate.length).toBeGreaterThan(0)
    for (const relPath of config.mutate) {
      expect(await existsInRepo(relPath), `stryker mutate path missing: ${relPath}`).toBe(true)
    }
  })

  it("package.json files allowlist only references existing paths", async () => {
    const pkg = JSON.parse(await readRepoFile("package.json")) as { files?: string[] }
    expect(Array.isArray(pkg.files)).toBe(true)
    for (const entry of pkg.files ?? []) {
      expect(await existsInRepo(entry), `package.json files entry missing: ${entry}`).toBe(true)
    }
  })

  it("install scripts copy only kit-owned paths", async () => {
    const allowed = new Set([
      "AGENTS.md",
      "opencode.jsonc.example",
      "package.json",
      "package-lock.json",
      "agents",
      "commands",
      "templates",
      "skills",
      "tools",
      "plugins",
      "docs",
    ])

    const slug = await readPkgName()
    const shell = await readRepoFile("install.sh")
    const copyLines = shell.split("\n").filter(line => /^\s*cp\b/.test(line))
    expect(copyLines.length).toBeGreaterThan(0)
    for (const line of copyLines) {
      const match = line.match(new RegExp(`${escapeRegExp(slug)}[\\\\/]([\\w.-]+)`))
      if (!match) continue
      expect(allowed.has(match[1]), `install.sh copies unexpected path: ${match[1]}`).toBe(true)
    }

    const powershell = await readRepoFile("install.ps1")
    const sources = [...powershell.matchAll(/Join-Path \$CloneDir "([^"]+)"/g)]
    expect(sources.length).toBeGreaterThan(0)
    for (const match of sources) {
      expect(allowed.has(match[1]), `install.ps1 copies unexpected path: ${match[1]}`).toBe(true)
    }
  })

  it("install scripts ship the plugins directory", async () => {
    const slug = await readPkgName()
    const shell = await readRepoFile("install.sh")
    expect(shell, "install.sh must copy the plugins directory").toMatch(new RegExp(`${escapeRegExp(slug)}[\\\\/]plugins"`))

    const powershell = await readRepoFile("install.ps1")
    expect(powershell, "install.ps1 must copy the plugins directory").toContain('Join-Path $CloneDir "plugins"')
  })

  it("install scripts accept a ref, a directory and a dependency switch", async () => {
    const shell = await readRepoFile("install.sh")
    expect(shell, "install.sh must read --ref").toContain("--ref")
    expect(shell, "install.sh must read --dir").toContain("--dir")
    expect(shell, "install.sh must read --skip-deps").toContain("--skip-deps")

    const powershell = await readRepoFile("install.ps1")
    expect(powershell, "install.ps1 must read -Ref").toContain("[string]$Ref")
    expect(powershell, "install.ps1 must read -Dir").toContain("[string]$Dir")
    expect(powershell, "install.ps1 must read -SkipDeps").toContain("[switch]$SkipDeps")
  })

  it("install scripts keep the files they replace in a timestamped backup folder", async () => {
    for (const script of ["install.sh", "install.ps1"]) {
      const content = await readRepoFile(script)
      expect(content, `${script} must back up the files it replaces`).toContain(".install-backups")
    }
  })

  it("install scripts never overwrite the configuration file they only bootstrap", async () => {
    for (const script of ["install.sh", "install.ps1"]) {
      const content = await readRepoFile(script)
      const bootstrap = content.split("\n").filter(line => line.includes("opencode.jsonc") && line.includes("opencode.jsonc.example"))
      expect(bootstrap.length, `${script} must copy opencode.jsonc.example only once`).toBe(1)
    }
  })

  it("the install workflow proves both installers, the flags and the backup path", async () => {
    const workflow = await readRepoFile(".github/workflows/install.yml")
    const markers = [
      "install.sh", "install.ps1",
      "--ref", "-Ref",
      "--dir", "-Dir",
      "--skip-deps", "-SkipDeps",
      "verify-install.sh", "verify-install.ps1",
      "--backup", "-Backup",
      "tools/install/cli.mjs", "npm-linux", "npm-windows",
    ]
    for (const marker of markers) {
      expect(workflow, `install.yml must mention ${marker}`).toContain(marker)
    }
  })

  it("README documents how to register the shipped plugins", async () => {
    const readme = await readRepoFile("README.md")
    // OpenCode 2 discovers the shipped shims from the plugins folder without any configuration entry.
    expect(readme).toContain("discovers every direct plugin file inside the plugins folder of the configuration directory")
    // The plugins array only accepts directories and packages, because file paths are skipped with a warning.
    expect(readme).toContain("directories or package names, because file paths are ignored")
  })
})

describe("naming hygiene keeps one canonical identity", () => {
  it.skipIf(!hasGit)("tracked files never mention the retired slug", async () => {
    const retired = ["opencode", "sdd", "kit"].join("-")
    const offenders: string[] = []
    for (const file of [...ownedRepoFiles()]) {
      const content = await readRepoFile(file)
      if (content.includes(retired)) offenders.push(file)
    }
    expect(offenders, `the retired slug survives in: ${offenders.join(", ")}`).toEqual([])
  })

  it("installers, the README and the root warning point at the package name", async () => {
    const slug = await readPkgName()
    expect(await readRepoFile("install.sh")).toContain(`REPO="Nemryz/${slug}"`)
    expect(await readRepoFile("install.ps1")).toContain(`Nemryz/${slug}`)
    expect(await readRepoFile("README.md")).toContain(`github.com/Nemryz/${slug}`)
    expect(await readRepoFile("tools/shared/types.ts")).toContain(`${slug} installation directory`)
  })

  it("installers default to the V2 branch", async () => {
    expect(await readRepoFile("install.sh")).toContain('REF="V2"')
    expect(await readRepoFile("install.ps1")).toContain('[string]$Ref = "V2"')
  })
})

describe("shipped agents keep a single valid frontmatter block", () => {
  it.skipIf(!hasGit)("is not shadowed by a second frontmatter block injected by another plugin", async () => {
    const agentFiles = trackedUnder("agents/")
    expect(agentFiles.length).toBeGreaterThan(0)

    for (const file of agentFiles) {
      const content = await readRepoFile(file)
      const lines = content.split(/\r?\n/)

      expect(lines[0]?.trim(), `${file} must start with frontmatter`).toBe("---")

      const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
      expect(closing, `${file} has an unterminated frontmatter block`).toBeGreaterThan(0)

      const frontmatter = lines.slice(1, closing)
      expect(frontmatter.some(line => line.startsWith("description:")), `${file} missing description`).toBe(true)
      expect(frontmatter.some(line => line.startsWith("mode:")), `${file} missing mode`).toBe(true)

      const afterFrontmatter = lines.slice(closing + 1).find(line => line.trim() !== "")
      expect(
        afterFrontmatter?.trim(),
        `${file} has an injected second frontmatter block`,
      ).not.toBe("---")
    }
  })
})