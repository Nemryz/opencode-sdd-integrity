import fs from "node:fs/promises"
import path from "node:path"
import { readSession } from "../io"
import type { SnapshotManifest } from "../schemas"
import { createSnapshot, listSnapshots, readSnapshotManifest } from "./manifest"
import { collectScope, readDrillInfo, sha256 } from "./paths"
import { drillSnapshot } from "./retention"

// This module owns the automatic recovery point that every risky operation takes before it changes state.

export interface TriggerSnapshotOptions {
  feature?: string | null
  phase?: string | null
  now?: Date
  skipIfUnchanged?: boolean
}

export interface TriggerSnapshotResult {
  ok: boolean
  snapshotId: string | null
  reused: boolean
  error: string | null
}

// Compares the live scope with a manifest so an unchanged state can reuse its snapshot instead of copying again.
async function scopeMatchesManifest(root: string, manifest: SnapshotManifest): Promise<boolean> {
  const relPaths = await collectScope(root)
  if (relPaths.length !== manifest.files.length) return false
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]))
  for (const rel of relPaths) {
    const sha = expected.get(rel)
    if (!sha) return false
    try {
      const content = await fs.readFile(path.join(root, ...rel.split("/")))
      if (sha256(content) !== sha) return false
    } catch {
      return false
    }
  }
  return true
}

// Guarantees a restorable recovery point by reusing or creating a snapshot and proving it with a drill.
export async function snapshotBeforeOperation(
  root: string,
  trigger: string,
  options?: TriggerSnapshotOptions,
): Promise<TriggerSnapshotResult> {
  try {
    let feature = options?.feature ?? null
    let phase = options?.phase ?? null
    if (feature === null || phase === null) {
      const session = await readSession(root)
      if (feature === null) feature = session.featureDir ?? null
      if (phase === null) phase = session.phase ?? null
    }

    let snapshotId: string | null = null
    let reused = false
    if (options?.skipIfUnchanged !== false) {
      const entries = await listSnapshots(root)
      const newest = entries[0]
      if (newest && newest.status === "verified") {
        const manifest = await readSnapshotManifest(root, newest.id)
        if (manifest && await scopeMatchesManifest(root, manifest)) {
          snapshotId = newest.id
          reused = true
        }
      }
    }

    if (!snapshotId) {
      const created = await createSnapshot(root, { trigger, feature, phase, now: options?.now })
      snapshotId = created.id
    }

    const existingDrill = await readDrillInfo(root, snapshotId)
    if (existingDrill?.ok !== true) {
      const drill = await drillSnapshot(root, snapshotId, { now: options?.now })
      if (!drill.ok) {
        return {
          ok: false,
          snapshotId,
          reused,
          error: `snapshot ${snapshotId} drill failed: ${drill.error ?? "unknown error"}`,
        }
      }
    }
    return { ok: true, snapshotId, reused, error: null }
  } catch (err) {
    return {
      ok: false,
      snapshotId: null,
      reused: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface FailureSnapshotResult {
  snapshotId: string | null
  error: string | null
}

export function postFailureNote(failure: FailureSnapshotResult): string {
  if (failure.snapshotId) return ` Post-failure snapshot: ${failure.snapshotId}.`
  if (failure.error) return ` Post-failure snapshot failed: ${failure.error}.`
  return ""
}

// Captures the state that a failed operation left behind so the damage can be inspected afterwards.
export async function snapshotAfterFailure(
  root: string,
  trigger: string,
  options?: { feature?: string | null; phase?: string | null; now?: Date },
): Promise<FailureSnapshotResult> {
  try {
    const created = await createSnapshot(root, {
      trigger,
      feature: options?.feature ?? null,
      phase: options?.phase ?? null,
      now: options?.now,
    })
    return { snapshotId: created.id, error: null }
  } catch (err) {
    return { snapshotId: null, error: err instanceof Error ? err.message : String(err) }
  }
}
