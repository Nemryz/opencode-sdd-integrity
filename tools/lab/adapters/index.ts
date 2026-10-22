import type { LabAdapter } from "../core/types"
import { integrityAdapter, isIntegrityRepo } from "./integrity"
import { createNodeAdapter, isNodeRepo } from "./node"

export type AdapterChoice = "auto" | "integrity" | "node"

export async function selectAdapter(repoRoot: string, requested: AdapterChoice = "auto"): Promise<LabAdapter> {
  if (requested === "integrity") return integrityAdapter
  if (requested === "node") return createNodeAdapter(repoRoot)
  if (await isIntegrityRepo(repoRoot)) return integrityAdapter
  if (await isNodeRepo(repoRoot)) return createNodeAdapter(repoRoot)
  throw new Error("No lab adapter matched this project; add package.json or choose the integrity adapter explicitly")
}

export { integrityAdapter, createNodeAdapter, isIntegrityRepo, isNodeRepo }
