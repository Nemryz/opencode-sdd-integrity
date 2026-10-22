// This module owns the feature directory name checks and the path resolution that every state writer uses.

import path from "node:path"
import { specsDirPath } from "./schemas"

export function isSafeFeatureDirName(input: string): boolean {
  if (!input) return false
  if (path.isAbsolute(input)) return false
  if (input.includes("/") || input.includes("\\")) return false
  if (input === "." || input === "..") return false
  return true
}

export function resolveFeatureDir(projectRoot: string, input: string): string | null {
  if (!isSafeFeatureDirName(input)) return null
  const specsDir = path.resolve(specsDirPath(projectRoot))
  const resolved = path.resolve(specsDir, input)
  if (resolved === specsDir || !resolved.startsWith(specsDir + path.sep)) return null
  return resolved
}
