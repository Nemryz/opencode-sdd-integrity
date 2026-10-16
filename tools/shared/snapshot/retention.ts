import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Dirent } from "node:fs"
import { atomicWriteFile } from "../io"
import { SnapshotDrillSchema, SnapshotPinSchema, type SnapshotDrill, type SnapshotPin } from "../schemas"
import { readSnapshotManifest, type SnapshotListEntry } from "./manifest"
import {
  assertSafeManifestPath,
  drillPath,
  pinPath,
  readDrillInfo,
  readPinInfo,
  readRestoreJournal,
  sha256,
  snapshotsDirPath,
} from "./paths"

// This module owns everything that keeps snapshots around, meaning pins, drills, retention and readiness.

export async function pinSnapshot(
  root: string,
  id: string,
  label?: string | null,
  options?: { now?: Date },
): Promise<SnapshotPin> {
  const manifest = await readSnapshotManifest(root, id)
  if (!manifest) {
    throw new Error(`snapshot ${id} is unreadable`)
  }
  const pin = SnapshotPinSchema.parse({
    pinned_at: (options?.now ?? new Date()).toISOString(),
    label: label ?? null,
  })
  await atomicWriteFile(pinPath(root, id), JSON.stringify(pin, null, 2))
  return pin
}

export async function unpinSnapshot(root: string, id: string): Promise<boolean> {
  const existed = (await readPinInfo(root, id)) !== null
  await fs.rm(pinPath(root, id), { force: true })
  return existed
}

// Replays a restore into a temporary sandbox so the snapshot proves it can be applied.
export async function drillSnapshot(root: string, id: string, options?: { now?: Date }): Promise<SnapshotDrill> {
  const manifest = await readSnapshotManifest(root, id)
  if (!manifest) {
    throw new Error(`snapshot ${id} is unreadable`)
  }
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-drill-"))
  let filesChecked = 0
  let error: string | null = null
  try {
    for (const file of manifest.files) {
      assertSafeManifestPath(file.path)
      const content = await fs.readFile(path.join(snapshotsDirPath(root), id, ...file.path.split("/")))
      if (sha256(content) !== file.sha256) {
        error = `checksum mismatch: ${file.path}`
        break
      }
      const dest = path.join(sandbox, ...file.path.split("/"))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, content)
      filesChecked++
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
  const drill = SnapshotDrillSchema.parse({
    drilled_at: (options?.now ?? new Date()).toISOString(),
    ok: error === null,
    files_checked: filesChecked,
    error,
  })
  await atomicWriteFile(drillPath(root, id), JSON.stringify(drill, null, 2))
  return drill
}

export const AUTO_CAP_PER_FEATURE = 5
export const TOTAL_CAP = 10

export interface PruneReport {
  removed: string[]
  kept: number
  protectedIds: string[]
  unreadable: string[]
  aborted: boolean
  abortReason: string | null
}

interface PruneCandidate {
  id: string
  trigger: string
  feature: string | null
  pinned: boolean
  drillOk: boolean
}

// Ranks triggers so manual snapshots outlive phase transitions which outlive automatic repair points.
function triggerValue(trigger: string): number {
  if (trigger === "manual") return 3
  if (trigger.startsWith("phase")) return 2
  if (trigger.startsWith("pre-restore")) return 1
  return 0
}

function pruneOrder(list: PruneCandidate[]): PruneCandidate[] {
  return [...list].sort((a, b) => {
    const valueDiff = triggerValue(a.trigger) - triggerValue(b.trigger)
    if (valueDiff !== 0) return valueDiff
    return a.id.localeCompare(b.id)
  })
}

// Trims snapshots down to the caps while protecting the newest, the pinned and the last drilled ones.
export async function pruneSnapshots(root: string): Promise<PruneReport> {
  const journal = await readRestoreJournal(root)
  if (journal) {
    return {
      removed: [],
      kept: 0,
      protectedIds: [journal.snapshot_id, journal.safety_snapshot_id],
      unreadable: [],
      aborted: true,
      abortReason: "restore journal present — run recoverInterruptedRestore first",
    }
  }

  const dir = snapshotsDirPath(root)
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
  const unreadable: string[] = []
  const candidates: PruneCandidate[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const manifest = await readSnapshotManifest(root, dirent.name)
    if (!manifest) {
      unreadable.push(dirent.name)
      continue
    }
    const pin = await readPinInfo(root, dirent.name)
    const drill = await readDrillInfo(root, dirent.name)
    candidates.push({
      id: dirent.name,
      trigger: manifest.trigger,
      feature: manifest.feature,
      pinned: pin !== null,
      drillOk: drill?.ok === true,
    })
  }

  const protectedIds = new Set<string>()
  const idsAscending = candidates.map((c) => c.id).sort()
  const newest = idsAscending[idsAscending.length - 1]
  if (newest) protectedIds.add(newest)
  for (const candidate of candidates) {
    if (candidate.pinned) protectedIds.add(candidate.id)
  }
  const drilledOk = candidates.filter((c) => c.drillOk).map((c) => c.id).sort()
  const lastDrilled = drilledOk[drilledOk.length - 1]
  if (lastDrilled) protectedIds.add(lastDrilled)

  const remaining = new Map(candidates.map((c) => [c.id, c]))
  const removed: string[] = []
  const tryRemove = async (candidate: PruneCandidate): Promise<boolean> => {
    if (protectedIds.has(candidate.id)) return false
    await fs.rm(path.join(dir, candidate.id), { recursive: true, force: true })
    removed.push(candidate.id)
    remaining.delete(candidate.id)
    return true
  }

  const features = new Set([...remaining.values()].map((c) => c.feature ?? ""))
  for (const feature of features) {
    const autos = pruneOrder(
      [...remaining.values()].filter((c) => (c.feature ?? "") === feature && c.trigger !== "manual"),
    )
    let count = autos.length
    for (const candidate of autos) {
      if (count <= AUTO_CAP_PER_FEATURE) break
      if (await tryRemove(candidate)) count--
    }
  }

  let total = remaining.size
  for (const candidate of pruneOrder([...remaining.values()])) {
    if (total <= TOTAL_CAP) break
    if (await tryRemove(candidate)) total--
  }

  return {
    removed,
    kept: remaining.size,
    protectedIds: [...protectedIds].filter((id) => remaining.has(id)),
    unreadable,
    aborted: false,
    abortReason: null,
  }
}

// Answers the single question of whether the project can recover today, with the reasons behind the verdict.
export function computeRecoveryReadiness(
  entries: SnapshotListEntry[],
  journalPending: boolean,
): { status: string; reasons: string[] } {
  if (journalPending) {
    return { status: "NOT READY", reasons: ["interrupted restore pending — run recover"] }
  }
  if (entries.length === 0) {
    return { status: "NOT READY", reasons: ["no snapshots yet — run create"] }
  }
  const newest = entries[0]
  if (newest && newest.status !== "verified") {
    return { status: "NOT READY", reasons: [`newest snapshot ${newest.id} failed verification`] }
  }
  const reasons: string[] = []
  if (!entries.some((entry) => entry.drill === "ok")) {
    reasons.push("no snapshot has been drilled yet")
  }
  const autosPerFeature = new Map<string, number>()
  for (const entry of entries) {
    if ((entry.trigger ?? "") === "manual") continue
    const key = entry.feature ?? ""
    autosPerFeature.set(key, (autosPerFeature.get(key) ?? 0) + 1)
  }
  const overFeatureCap = [...autosPerFeature.values()].some((count) => count > AUTO_CAP_PER_FEATURE)
  if (overFeatureCap || entries.length > TOTAL_CAP) {
    reasons.push("retention over caps — run prune")
  }
  return { status: reasons.length === 0 ? "READY" : "DEGRADED", reasons }
}
