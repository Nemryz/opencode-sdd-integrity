import path from "node:path"
import { z } from "zod"

export const PATHS = {
  OPENCODE_DIR: ".opencode",
  SPEC_MEMORY_DIR: "spec-memory",
  STEERING_DIR: "steering",
  SESSION_FILE: "session.json",
  CONFIG_FILE: "config.json",
  CONSTITUTION_FILE: "constitution.md",
  PRODUCT_STEERING_FILE: "product.md",
  TECH_STEERING_FILE: "tech.md",
  STRUCTURE_STEERING_FILE: "structure.md",
  SPECS_DIR: "specs",
} as const

export function sessionPath(root: string): string {
  return path.join(root, PATHS.OPENCODE_DIR, PATHS.SPEC_MEMORY_DIR, PATHS.SESSION_FILE)
}

export function configPath(root: string): string {
  return path.join(root, PATHS.OPENCODE_DIR, PATHS.SPEC_MEMORY_DIR, PATHS.CONFIG_FILE)
}

export function constitutionPath(root: string): string {
  return path.join(root, PATHS.OPENCODE_DIR, PATHS.SPEC_MEMORY_DIR, PATHS.CONSTITUTION_FILE)
}

export function specJsonPath(featureDir: string): string {
  return path.join(featureDir, "spec.json")
}

export function specsDirPath(root: string): string {
  return path.join(root, PATHS.SPECS_DIR)
}

export function steeringDirPath(root: string): string {
  return path.join(root, PATHS.OPENCODE_DIR, PATHS.STEERING_DIR)
}

export function productSteeringPath(root: string): string {
  return path.join(steeringDirPath(root), PATHS.PRODUCT_STEERING_FILE)
}

export function techSteeringPath(root: string): string {
  return path.join(steeringDirPath(root), PATHS.TECH_STEERING_FILE)
}

export function structureSteeringPath(root: string): string {
  return path.join(steeringDirPath(root), PATHS.STRUCTURE_STEERING_FILE)
}

export const ApprovalStateSchema = z.object({
  generated: z.boolean(),
  approved: z.boolean(),
  approved_at: z.string().optional(),
  hash: z.string().optional(),
})

export const SpecJsonSchema = z.object({
  feature_name: z.string().min(1),
  feature_number: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  phase: z.enum(["spec", "plan", "tasks", "ready", "impl", "complete"]),
  approvals: z.object({
    spec: ApprovalStateSchema,
    plan: ApprovalStateSchema,
    tasks: ApprovalStateSchema,
  }),
  ready_for_implementation: z.boolean(),
  active_delta: z.string().nullable().optional(),
})

export const SessionStateSchema = z.object({
  command: z.string().nullable(),
  phase: z.enum(["init", "spec", "plan", "tasks", "ready", "impl", "complete"]),
  featureDir: z.string().nullable(),
  featureNumber: z.number().nullable(),
  featureName: z.string().nullable(),
  nextStep: z.string().nullable(),
  lastResult: z.string().nullable(),
  history: z.array(z.string()),
})

export const ConfigSchema = z.object({
  defaultTechStack: z.string().nullable(),
  lastUsedLanguage: z.string().nullable(),
  expressMode: z.boolean(),
  autoVersioning: z.boolean(),
  preferences: z.record(z.string(), z.string()),
})

export type ApprovalState = z.infer<typeof ApprovalStateSchema>
export type Phase = z.infer<typeof SpecJsonSchema>["phase"]
export type SpecJson = z.infer<typeof SpecJsonSchema>
export type SessionState = z.infer<typeof SessionStateSchema>
export type SDDConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_SESSION: SessionState = {
  command: null,
  phase: "init",
  featureDir: null,
  featureNumber: null,
  featureName: null,
  nextStep: "/spec <description>",
  lastResult: null,
  history: [],
}

export const DEFAULT_CONFIG: SDDConfig = {
  defaultTechStack: null,
  lastUsedLanguage: null,
  expressMode: false,
  autoVersioning: false,
  preferences: {},
}

export const PHASE_NEXT_STEP: Record<string, string> = {
  init: "/spec <description>",
  spec: "/plan <tech stack>",
  plan: "/tasks",
  tasks: "/tasks (approve) or /impl",
  ready: "/impl or /review",
  impl: "/impl (continue)",
  complete: "/review or start a new feature",
}

const VALID_PHASES: readonly string[] = ["spec", "plan", "tasks", "ready", "impl", "complete"]

function isPhase(s: string): s is Phase {
  return VALID_PHASES.includes(s)
}

export function parsePhase(s: string): Phase {
  if (s === "init") return "spec"
  return isPhase(s) ? s : "spec"
}

// ─────────────────────────── Frontmatter Schema ───────────────────────────

export const AuditMetadataSchema = z.object({
  date: z.string(),
  findings: z.number(),
  severity: z.enum(["low", "medium", "high", "critical"]),
})

export const FrontmatterSchema = z.object({
  feature_name: z.string().optional(),
  feature_number: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  phase: z.enum(["spec", "plan", "tasks", "ready", "impl", "complete"]).optional(),
  status: z.enum(["generated", "validated", "approved"]).optional(),
  checksum: z.string().optional(),
  boundaries: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  last_audit: AuditMetadataSchema.optional(),
})

export type AuditMetadata = z.infer<typeof AuditMetadataSchema>
export type FrontmatterData = z.infer<typeof FrontmatterSchema>

// ─────────────────────────── Snapshot Schemas ───────────────────────────

export const SnapshotFileEntrySchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
})

export const SnapshotManifestSchema = z.object({
  format: z.literal(1),
  id: z.string().min(1),
  created_at: z.string(),
  trigger: z.string().min(1),
  feature: z.string().nullable(),
  phase: z.string().nullable(),
  files: z.array(SnapshotFileEntrySchema),
})

export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>

export const RestoreJournalSchema = z.object({
  format: z.literal(1),
  snapshot_id: z.string().min(1),
  safety_snapshot_id: z.string().min(1),
  mode: z.enum(["full", "selective"]),
  started_at: z.string(),
  files: z.array(z.string()),
  removed: z.array(z.string()),
})

export type RestoreJournal = z.infer<typeof RestoreJournalSchema>

export const SnapshotPinSchema = z.object({
  pinned_at: z.string(),
  label: z.string().nullable(),
})

export type SnapshotPin = z.infer<typeof SnapshotPinSchema>

export const SnapshotDrillSchema = z.object({
  drilled_at: z.string(),
  ok: z.boolean(),
  files_checked: z.number().int().nonnegative(),
  error: z.string().nullable(),
})

export type SnapshotDrill = z.infer<typeof SnapshotDrillSchema>

// ─────────────────────────── Delta Schemas ───────────────────────────

export const DeltaStatusSchema = z.enum(["draft", "planned", "ready", "implementing", "consolidated", "cancelled"])
export const DeltaTypeSchema = z.enum(["feature", "fix", "refactor"])
export const DeltaImpactSchema = z.enum(["low", "medium", "high"])

export const DeltaSchema = z.object({
  id: z.string(),
  type: DeltaTypeSchema,
  title: z.string(),
  status: DeltaStatusSchema,
  impact: DeltaImpactSchema,
  parent_feature: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  consolidated_at: z.string().optional(),
})

export const DeltasIndexSchema = z.object({
  feature: z.string(),
  deltas: z.array(DeltaSchema),
})

export const DeltaFrontmatterSchema = z.object({
  delta_id: z.string(),
  type: DeltaTypeSchema,
  status: DeltaStatusSchema,
  impact: DeltaImpactSchema,
  parent_feature: z.string(),
  parent_spec_hash: z.string().optional(),
})

export type DeltaStatus = z.infer<typeof DeltaStatusSchema>
export type DeltaType = z.infer<typeof DeltaTypeSchema>
export type DeltaImpact = z.infer<typeof DeltaImpactSchema>
export type Delta = z.infer<typeof DeltaSchema>
export type DeltasIndex = z.infer<typeof DeltasIndexSchema>
export type DeltaFrontmatterData = z.infer<typeof DeltaFrontmatterSchema>

// ─────────────────────────── Health Check Schema ───────────────────────────

export const HealthStatusSchema = z.enum(["healthy", "corrupted", "restored", "missing"])

export const FeatureHealthSchema = z.object({
  dir: z.string(),
  spec_json: HealthStatusSchema,
  backups: z.object({
    total: z.number(),
    valid: z.number(),
    corrupted: z.number(),
  }),
})

export const HealthReportSchema = z.object({
  session: z.object({ status: HealthStatusSchema, file: z.string() }),
  config: z.object({ status: HealthStatusSchema, file: z.string() }),
  features: z.array(FeatureHealthSchema),
  overall: z.enum(["healthy", "degraded", "critical"]),
})

export type HealthStatus = z.infer<typeof HealthStatusSchema>
export type FeatureHealth = z.infer<typeof FeatureHealthSchema>
export type HealthReport = z.infer<typeof HealthReportSchema>

// ─────────────────────── Mutation Batches Schema ───────────────────────

export const MutationBatchSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "batch id must be kebab case"),
  // A blank description reads like a documented batch while explaining nothing, so it is rejected here.
  description: z.string().min(1).refine((value) => value.trim().length > 0, "batch description must not be blank"),
  mutate: z.array(z.string().min(1)).min(1),
})

export const MutationBatchesSchema = z.object({
  format: z.literal(1),
  batches: z.array(MutationBatchSchema).min(1),
})

export type MutationBatch = z.infer<typeof MutationBatchSchema>
export type MutationBatches = z.infer<typeof MutationBatchesSchema>
