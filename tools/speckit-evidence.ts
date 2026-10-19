import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import {
  approvalAwareNextStep,
  clearCorruptionWarnings,
  collectTaskIds,
  exists,
  getLatestFeatureDir,
  getProjectRootWarnings,
  isSafeFeatureDirName,
  makeEvidenceFile,
  readSession,
  readSpecJson,
  resolveFeatureDir,
  resolveProjectRoot,
  stripBom,
  trimEvidenceEntries,
  withLock,
  writeWithBackup,
} from "./shared/types"
import type { EvidenceEntry, EvidenceFile } from "./shared/schemas"
import { EvidenceFileSchema } from "./shared/schemas"

const EVIDENCE_MAX_ENTRIES = 500

type EvidenceRead = { ok: true; file: EvidenceFile } | { ok: false }

function evidencePath(featureDir: string): string {
  return path.join(featureDir, "evidence.json")
}

async function readEvidenceFile(featureDir: string): Promise<EvidenceRead> {
  const fp = evidencePath(featureDir)
  let data: string
  try {
    data = await fs.readFile(fp, "utf-8")
  } catch {
    return { ok: true, file: makeEvidenceFile(path.basename(featureDir)) }
  }
  try {
    const result = EvidenceFileSchema.safeParse(JSON.parse(stripBom(data)))
    if (result.success) return { ok: true, file: result.data }
  } catch {
    // fall through to the corrupt branch so an unreadable file is never overwritten
  }
  return { ok: false }
}

function corruptEvidenceError(featureDir: string) {
  return {
    title: "Error",
    output: `Evidence file ${evidencePath(featureDir)} is corrupt or invalid. Refusing to overwrite it. Restore it from .opencode/backups or remove it manually.`,
  }
}

type AppendResult = { ok: true; file: EvidenceFile } | { ok: false }

// Serializes the whole read, append and write so parallel task records cannot lose entries.
async function appendEvidence(featureDir: string, projectRoot: string, entry: EvidenceEntry): Promise<AppendResult> {
  const fp = evidencePath(featureDir)
  return withLock(fp, async () => {
    const read = await readEvidenceFile(featureDir)
    if (!read.ok) return { ok: false }
    const entries = trimEvidenceEntries([...read.file.entries, entry], EVIDENCE_MAX_ENTRIES)
    const updated: EvidenceFile = { feature: read.file.feature, updated_at: entry.at, entries }
    await writeWithBackup(fp, JSON.stringify(updated, null, 2), projectRoot)
    return { ok: true, file: updated }
  })
}

type RecordArgs = {
  task?: string
  testCommand?: string
  exitCode?: number
  note?: string
}

async function handleRecord(featureDir: string, projectRoot: string, args: RecordArgs) {
  const testCommand = (args.testCommand ?? "").trim()
  if (!testCommand) {
    return { title: "Error", output: "testCommand is required. Pass the exact command that was run." }
  }

  const entry: EvidenceEntry = {
    task: (args.task ?? "feature").trim() || "feature",
    test_command: testCommand,
    exit_code: typeof args.exitCode === "number" && Number.isFinite(args.exitCode) ? Math.trunc(args.exitCode) : 0,
    at: new Date().toISOString(),
  }
  if (args.note && args.note.trim()) entry.note = args.note.trim()

  const appended = await appendEvidence(featureDir, projectRoot, entry)
  if (!appended.ok) return corruptEvidenceError(featureDir)
  const entries = appended.file.entries

  const sj = await readSpecJson(featureDir)
  const next = approvalAwareNextStep(sj, sj?.phase === "complete" ? "/review or start a new feature" : "/impl (continue)")
  const entryLabel = entries.length === 1 ? "entry" : "entries"
  return {
    title: `Evidence: ${entry.task}`,
    output: `${entry.task}: ${testCommand} recorded with exit ${entry.exit_code} (${entries.length} ${entryLabel}).  Next: ${next}`,
    metadata: { task: entry.task, exitCode: entry.exit_code, entries: entries.length },
  }
}

async function handleStatus(featureDir: string, featureName: string) {
  const read = await readEvidenceFile(featureDir)
  if (!read.ok) return corruptEvidenceError(featureDir)
  const entries = read.file.entries

  if (entries.length === 0) {
    return {
      title: `Evidence: ${featureName}`,
      output: "No test evidence recorded yet. Every implementation verification records its run with speckit-evidence.",
      metadata: { entries: 0 },
    }
  }

  const tasksPath = path.join(featureDir, "tasks.md")
  const tasksContent = await fs.readFile(tasksPath, "utf-8").catch(() => "")
  const taskIds = collectTaskIds(tasksContent)
  if (taskIds.length === 0) {
    return {
      title: `Evidence: ${featureName}`,
      output: `Evidence: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}, no task IDs found in tasks.md`,
      metadata: { entries: entries.length, tasks: 0 },
    }
  }

  const missing: string[] = []
  const failing: string[] = []
  let covered = 0
  for (const id of taskIds) {
    const own = entries.filter(e => e.task === id)
    if (own.length === 0) {
      missing.push(id)
      continue
    }
    covered += 1
    const last = own[own.length - 1]
    if (last.exit_code !== 0) failing.push(`${id} (${last.test_command}, exit ${last.exit_code})`)
  }

  const lines = [`Evidence: ${covered}/${taskIds.length} tasks covered (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`]
  if (missing.length > 0) lines.push(`  missing: ${missing.join(", ")}`)
  if (failing.length > 0) lines.push(`  failing latest: ${failing.join(" | ")}`)

  return {
    title: `Evidence: ${featureName}`,
    output: lines.join("\n"),
    metadata: { entries: entries.length, tasks: taskIds.length, covered, missing, failing },
  }
}

export default tool({
  description: "Record and report TDD test evidence for the current feature",
  args: {
    command: tool.schema.enum(["record", "status"]).describe("Evidence command to run"),
    task: tool.schema.string().optional().describe("Task identifier the evidence belongs to (e.g., T-003)"),
    testCommand: tool.schema.string().optional().describe("Exact test command that was run (required for record)"),
    exitCode: tool.schema.number().optional().describe("Exit code of the test command (default 0)"),
    note: tool.schema.string().optional().describe("Optional note stored with the entry"),
    featureDir: tool.schema.string().optional().describe("Feature directory"),
    confirmed: tool.schema.boolean().optional().describe("Set to true only after the user explicitly confirms the project-root warning"),
  },
  async execute(args, context) {
    clearCorruptionWarnings()
    try {
      const resolved = await resolveProjectRoot(context)
      if (!resolved.root) return { title: "Error", output: resolved.error ?? "Not a valid project directory" }
      const projectRoot = resolved.root
      const projectWarnings = await getProjectRootWarnings(projectRoot)
      if (projectWarnings.length > 0 && !args.confirmed) {
        return {
          title: "Warning",
          output: `${projectWarnings.map(w => w.message).join("\n\n")}\n\nAsk the user to confirm, then re-run with confirmed: true.`,
          metadata: { warnings: projectWarnings, requiresConfirmation: true },
        }
      }

      let targetDir: string
      if (args.featureDir !== undefined) {
        if (!isSafeFeatureDirName(args.featureDir)) {
          return { title: "Error", output: `Invalid featureDir: ${args.featureDir}` }
        }
        targetDir = args.featureDir
      } else {
        const session = await readSession(projectRoot)
        const latest = session.featureDir ?? await getLatestFeatureDir(projectRoot)
        if (!latest) {
          return { title: "Error", output: "No feature found. Run /spec first." }
        }
        targetDir = latest
      }

      const featureDir = resolveFeatureDir(projectRoot, targetDir)
      if (!featureDir) {
        return { title: "Error", output: `Invalid feature directory: ${targetDir}` }
      }
      if (!(await exists(path.join(featureDir, "spec.md")))) {
        return { title: "Error", output: `Feature ${targetDir} has no spec.md` }
      }

      const featureName = path.basename(featureDir)
      switch (args.command) {
        case "record":
          return await handleRecord(featureDir, projectRoot, args)
        case "status":
          return await handleStatus(featureDir, featureName)
        default:
          return { title: "Error", output: "Unknown evidence command" }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { title: "Error", output: `Evidence error: ${message}` }
    }
  },
})
