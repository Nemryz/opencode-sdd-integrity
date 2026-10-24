// This module owns the configuration file and the best effort auto versioning that follows a state write.

import path from "node:path"
import fs from "node:fs/promises"
import { configPath, SDDConfig, ConfigSchema, DEFAULT_CONFIG } from "../schemas"
import { withLock } from "../locks"
import { stateLockPath } from "./paths"
import { writeWithBackup, findLatestValidBackup } from "../backups"
import { stripBom, writeFileChecksum, verifyFileChecksum, verifyLiveFileChecksum } from "../checksums"
import { isENOENT } from "../errors"
import { pushCorruptionWarning } from "../warnings"

export async function readConfig(root: string): Promise<SDDConfig> {
  const fp = configPath(root)
  const configSuggestion = "Run /config to restore your settings"
  try {
    const checksumValid = await verifyFileChecksum(fp)
    if (!checksumValid) {
      pushCorruptionWarning(fp, "checksum mismatch, file may be corrupted", configSuggestion)
    }

    const data = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(data))
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    const result = ConfigSchema.safeParse(merged)
    if (result.success) {
      if (!checksumValid) await writeFileChecksum(fp)
      return result.data
    }
    pushCorruptionWarning(fp, result.error.message, configSuggestion)
    return { ...DEFAULT_CONFIG }
  } catch (err) {
    if (!isENOENT(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      pushCorruptionWarning(fp, msg, configSuggestion)
    }
    return { ...DEFAULT_CONFIG }
  }
}

const AUTO_COMMIT_MESSAGES: Record<string, string> = {
  "session.json": "auto: update session state",
  "spec.json": "auto: update spec state",
  "config.json": "auto: update config",
}

export async function tryAutoCommit(fp: string, root: string): Promise<void> {
  try {
    const gitDir = path.join(root, ".git")
    await fs.access(gitDir)
    const cfg = await readConfig(root)
    if (!cfg.autoVersioning) return
    const basename = path.basename(fp)
    const msg = AUTO_COMMIT_MESSAGES[basename] || `auto: update ${basename}`
    const { execSync } = await import("node:child_process")
    execSync(`git add "${fp}"`, { cwd: root, stdio: "ignore" })
    const diff = execSync(`git diff --cached -- "${fp}"`, { cwd: root, encoding: "utf-8" })
    if (onlyLastUsedLanguageChanged(diff)) {
      execSync(`git checkout HEAD -- "${fp}"`, { cwd: root, stdio: "ignore" })
      return
    }
    execSync(`git commit -m "${msg}"`, { cwd: root, stdio: "ignore" })
  } catch {
    // fail silently
  }
}

function onlyLastUsedLanguageChanged(diff: string): boolean {
  if (!diff) return false
  const lines = diff.split("\n").filter(l =>
    (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")))
  if (lines.length === 0) return false
  return lines.every(l => l.includes("lastUsedLanguage"))
}

export async function writeConfigWithBackup(root: string, cfg: SDDConfig): Promise<void> {
  const result = ConfigSchema.safeParse(cfg)
  if (!result.success) {
    throw new Error(`writeConfigWithBackup: validation failed, data not written: ${String(result.error)}`)
  }
  const fp = configPath(root)
  await withLock(stateLockPath(root), async () => {
    await withLock(fp, async () => {
      await writeWithBackup(fp, JSON.stringify(result.data, null, 2), root)
      await writeFileChecksum(fp)
    })
  })
  await tryAutoCommit(fp, root)
}

export async function readConfigWithRestore(root: string): Promise<SDDConfig> {
  const fp = configPath(root)
  const configSuggestion = "Run /config to restore your settings"
  try {
    const checksumValid = await verifyLiveFileChecksum(fp)
    if (!checksumValid) {
      pushCorruptionWarning(fp, "checksum mismatch, file may be corrupted", configSuggestion)
    }

    const data = await fs.readFile(fp, "utf-8")
    const parsed = JSON.parse(stripBom(data))
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    const result = ConfigSchema.safeParse(merged)
    if (result.success) {
      if (!checksumValid) await writeFileChecksum(fp)
      return result.data
    }
    pushCorruptionWarning(fp, result.error.message, configSuggestion)
    const restored = await findLatestValidBackup<SDDConfig>(fp, root, ConfigSchema)
    if (restored) {
      console.warn(`[SDD] Restored ${fp} from backup`)
      return restored
    }
    return { ...DEFAULT_CONFIG }
  } catch (err) {
    if (!isENOENT(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      pushCorruptionWarning(fp, msg, configSuggestion)
      const restored = await findLatestValidBackup<SDDConfig>(fp, root, ConfigSchema)
      if (restored) {
        console.warn(`[SDD] Restored ${fp} from backup`)
        return restored
      }
    }
    return { ...DEFAULT_CONFIG }
  }
}
