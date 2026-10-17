import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { ownedRepoFiles, repoRootDir } from "../helpers/setup"

const REPO_ROOT = repoRootDir()

const KIT_COMMANDS = [
  "approve",
  "audit",
  "clean",
  "config",
  "delta-status",
  "guard",
  "health",
  "impl",
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
      "opencode.jsonc",
      "package.json",
      "package-lock.json",
      "agents",
      "commands",
      "templates",
      "skills",
      "tools",
      "docs",
    ])
    for (const script of ["install.sh", "install.ps1"]) {
      const content = await readRepoFile(script)
      const copyLines = content.split("\n").filter(line => /^\s*(cp|Copy-Item)\b/.test(line))
      expect(copyLines.length).toBeGreaterThan(0)
      for (const line of copyLines) {
        const match = line.match(/opencode-sdd-kit[\\/]([\w.-]+)/)
        if (!match) continue
        expect(allowed.has(match[1]), `${script} copies unexpected path: ${match[1]}`).toBe(true)
      }
    }
  })

  it("README documents how to register both runtime plugins", async () => {
    const readme = await readRepoFile("README.md")
    expect(readme).toContain("./tools/plugins/speckit-perfmon.ts")
    expect(readme).toContain("./tools/plugins/speckit-guard.ts")
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