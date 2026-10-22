// This module owns the plugin marker and the health report that reads every state file without changing it.

import path from "node:path"
import fs from "node:fs/promises"
import { sessionPath, configPath, specsDirPath, HealthReport, FeatureHealth } from "./schemas"
import { withLock } from "./locks"
import { atomicWriteFile } from "./atomic"
import { stripBom, verifyLiveFileChecksum, verifyChecksum } from "./checksums"
import { backupSourceKey, BACKUP_DIR_NAME } from "./backups"

export async function markPluginLoaded(worktree: string, pluginId: string): Promise<void> {
  try {
    const markerPath = path.join(worktree, ".opencode", "plugins-state.json")
    await withLock(markerPath, async () => {
      let state: Record<string, { loadedAt: string }> = {}
      try {
        const parsed = JSON.parse(stripBom(await fs.readFile(markerPath, "utf-8")))
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          state = parsed
        }
      } catch {
        // first load, keep empty state
      }
      state[pluginId] = { loadedAt: new Date().toISOString() }
      await atomicWriteFile(markerPath, JSON.stringify(state, null, 2))
    })
  } catch {
    // markers are diagnostic only, plugin startup must never fail because of them
  }
}

export async function runHealthCheck(projectRoot: string): Promise<HealthReport> {
  const report: HealthReport = {
    session: { status: "healthy", file: sessionPath(projectRoot) },
    config: { status: "healthy", file: configPath(projectRoot) },
    features: [],
    overall: "healthy",
  }

  // Check session.json
  const sessionFp = sessionPath(projectRoot)
  try {
    await fs.access(sessionFp)
    const sessionValid = await verifyLiveFileChecksum(sessionFp)
    if (!sessionValid) {
      report.session.status = "corrupted"
    }
  } catch {
    report.session.status = "missing"
  }

  // Check config.json
  const configFp = configPath(projectRoot)
  try {
    await fs.access(configFp)
    const configValid = await verifyLiveFileChecksum(configFp)
    if (!configValid) {
      report.config.status = "corrupted"
    }
  } catch {
    report.config.status = "missing"
  }

  // Check features
  const sDir = specsDirPath(projectRoot)
  try {
    const entries = await fs.readdir(sDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const base = path.join(sDir, entry.name)
        const featureHealth: FeatureHealth = {
          dir: entry.name,
          spec_json: "healthy",
          backups: { total: 0, valid: 0, corrupted: 0 },
        }

        // Check spec.json
        const sjFp = path.join(base, "spec.json")
        try {
          await fs.access(sjFp)
          const sjValid = await verifyLiveFileChecksum(sjFp)
          if (!sjValid) {
            featureHealth.spec_json = "corrupted"
          }
        } catch {
          featureHealth.spec_json = "missing"
        }

        // Check backups
        const backupDir = path.join(projectRoot, ".opencode", BACKUP_DIR_NAME)
        try {
          const bakFiles = await fs.readdir(backupDir)
          const sjSourceKey = backupSourceKey(sjFp)
          const featureBaks = bakFiles.filter(f => f.startsWith(`${sjSourceKey}.`) && f.endsWith(".bak"))
          featureHealth.backups.total = featureBaks.length
          for (const bak of featureBaks) {
            const bakPath = path.join(backupDir, bak)
            try {
              const content = await fs.readFile(bakPath, "utf-8")
              const valid = await verifyChecksum(bakPath, content)
              if (valid) featureHealth.backups.valid++
              else featureHealth.backups.corrupted++
            } catch {
              featureHealth.backups.corrupted++
            }
          }
        } catch {
          // no backup dir
        }

        report.features.push(featureHealth)
      }
    }
  } catch {
    // no specs dir
  }

  // Determine overall status
  const hasCorrupted = report.session.status === "corrupted" || report.config.status === "corrupted"
    || report.features.some(f => f.spec_json === "corrupted")
  const hasRestored = report.session.status === "restored" || report.config.status === "restored"
    || report.features.some(f => f.spec_json === "restored")
  const hasMissing = report.session.status === "missing" || report.config.status === "missing"
    || report.features.some(f => f.spec_json === "missing")

  if (hasCorrupted || hasMissing) report.overall = "critical"
  else if (hasRestored) report.overall = "degraded"
  else report.overall = "healthy"

  return report
}
