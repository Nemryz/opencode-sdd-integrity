import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Stands up a small disposable git repository, so each corpus test owns a fresh attack surface.
export async function makeAttackRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lab-corpus-"))
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "corpus@example.com"])
  git(dir, ["config", "user.name", "Lab Corpus"])
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "lab-corpus-fixture" }, null, 2), "utf-8")
  await fs.writeFile(path.join(dir, "README.md"), "base\n", "utf-8")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "corpus base"])
  return dir
}

export async function destroyAttackRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

// Prepares the lab home so a fixture can place registry or report files at their real project paths.
export async function ensureAttackLabHome(repo: string): Promise<void> {
  const layout = path.join(repo, ".opencode", "lab")
  for (const part of ["sandboxes", "reports", "baselines", "registry", "patches", "audit"]) {
    await fs.mkdir(path.join(layout, part), { recursive: true })
  }
}
