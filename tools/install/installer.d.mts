// Type declarations for the plain ESM installer so the TypeScript test suite can import it.
export interface SurfaceFile {
  source: string
  target: string
}

export interface Surface {
  copyFiles: string[]
  copyDirs: string[]
  exampleFile: SurfaceFile
  verifyPaths: string[]
  optionalPaths: string[]
}

export interface PlanItem {
  name: string
  kind: "file" | "dir"
  exists: boolean
  available: boolean
}

export interface InstallPlan {
  packageName: string
  packageVersion: string
  targetDir: string
  items: PlanItem[]
  example: {
    source: string
    target: string
    needed: boolean
  }
}

export interface VerifyCheck {
  path: string
  ok: boolean
  optional: boolean
}

export interface VerifyResult {
  targetDir: string
  ok: boolean
  checks: VerifyCheck[]
}

export interface InstallResult {
  targetDir: string
  backupDir: string | null
  copied: string[]
  skipped: string[]
  exampleCreated: boolean
  deps: "skipped" | "installed"
  verification: VerifyResult
}

export interface DoctorCheck {
  name: string
  ok: boolean
  message: string
}

export interface DoctorResult {
  targetDir: string
  ok: boolean
  checks: DoctorCheck[]
  suggestions: string[]
}

export interface BackupEntry {
  stamp: string
  dir: string
  files: number
  size: number
  date: string
}

export interface ClassifiedError {
  type: string
  message: string
  suggestion: string
}

export interface InstallEvent {
  type: "skip" | "backup" | "example" | "deps"
  message: string
}

export const DEFAULT_PACKAGE_ROOT: string
export const SURFACE_FILE: string

export function readSurface(surfaceFile?: string): Promise<Surface>
export function resolveConfigDir(options?: { dir?: string | null; env?: Record<string, string | undefined>; home?: string }): string
export function buildPlan(options: { packageRoot?: string; targetDir: string }): Promise<InstallPlan>
export function runInstall(options: {
  packageRoot?: string
  targetDir: string
  skipDeps?: boolean
  runDeps?: (cwd: string) => Promise<void>
  onEvent?: (event: InstallEvent) => void
}): Promise<InstallResult>
export function verifyInstall(options: { targetDir: string; surface?: Surface }): Promise<VerifyResult>
export function doctorInstall(options: { targetDir: string; packageRoot?: string }): Promise<DoctorResult>
export function listBackups(targetDir: string): Promise<BackupEntry[]>
export function restoreBackup(targetDir: string, stamp: string, options?: { yes?: boolean }): Promise<{ restored: string; previousBackup: string }>
export function pruneBackups(targetDir: string, options?: { keep?: number; all?: boolean }): Promise<{ removed: number; kept: number }>
export function classifyError(error: unknown): ClassifiedError
export function checkNodeVersion(): number
export function readManifest(targetDir: string): Promise<Record<string, unknown> | null>
