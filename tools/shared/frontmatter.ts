// This module owns the frontmatter mirror that keeps the Markdown artifacts aligned with spec.json.

import path from "node:path"
import fs from "node:fs/promises"
import matter from "gray-matter"
import { FrontmatterSchema, type FrontmatterData, type SpecJson, type AuditMetadata } from "./schemas"
import { computeSha256 } from "./checksums"
import { atomicWriteFile } from "./atomic"

export async function readFrontmatter(filePath: string): Promise<FrontmatterData | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const parsed = matter(content)
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return null
    }
    const result = FrontmatterSchema.safeParse(parsed.data)
    if (!result.success) {
      return null
    }
    return result.data
  } catch {
    try {
      const content = await fs.readFile(filePath, "utf-8")
      const match = content.match(/^---\n([\s\S]*?)\n---/)
      if (match) {
        const lines = match[1].split("\n")
        const recovered: Record<string, unknown> = {}
        for (const line of lines) {
          const kvMatch = line.match(/^(\w+):\s*(.+)$/)
          if (kvMatch) {
            const [, key, rawVal] = kvMatch
            const val = rawVal.trim()
            if (key === "boundaries" || key === "depends_on") continue
            if (val === "true") recovered[key] = true
            else if (val === "false") recovered[key] = false
            else if (/^\d+$/.test(val)) recovered[key] = parseInt(val, 10)
            else recovered[key] = val.replace(/^["']|["']$/g, "")
          }
        }
        const result = FrontmatterSchema.safeParse(recovered)
        if (result.success) return result.data
      }
    } catch { /* ignore */ }
    return null
  }
}

export async function writeFrontmatter(filePath: string, data: FrontmatterData): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8")
  const parsed = matter(content)
  const merged = { ...parsed.data, ...data }
  const output = matter.stringify(parsed.content, merged)
  await atomicWriteFile(filePath, output)
}

export function computeBodyChecksum(content: string): string {
  const parsed = matter(content)
  const normalized = parsed.content.replace(/\r\n/g, "\n").trim()
  return computeSha256(normalized)
}

export async function verifyBodyIntegrity(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const fm = await readFrontmatter(filePath)
    if (!fm || !fm.checksum) return true
    const bodyChecksum = computeBodyChecksum(content)
    return fm.checksum === bodyChecksum
  } catch {
    return true
  }
}

export async function reconstructFromFrontmatter(featureDir: string): Promise<SpecJson | null> {
  const specPath = path.join(featureDir, "spec.md")
  const planPath = path.join(featureDir, "plan.md")
  const tasksPath = path.join(featureDir, "tasks.md")

  const specFm = await readFrontmatter(specPath)
  const planFm = await readFrontmatter(planPath)
  const tasksFm = await readFrontmatter(tasksPath)

  if (!specFm) return null

  const specOk = specFm.phase !== undefined
  const planOk = planFm?.phase !== undefined
  const tasksOk = tasksFm?.phase !== undefined

  let phase: SpecJson["phase"] = "spec"
  if (tasksOk) phase = "tasks"
  else if (planOk) phase = "plan"
  if (specOk && planOk && tasksOk) phase = "ready"

  if (specFm.phase) phase = specFm.phase

  return {
    feature_name: specFm.feature_name || path.basename(featureDir),
    feature_number: specFm.feature_number || 0,
    created_at: specFm.created_at || new Date().toISOString(),
    updated_at: specFm.updated_at || new Date().toISOString(),
    phase,
    approvals: {
      spec: { generated: specOk, approved: specFm.status === "approved" },
      plan: { generated: planOk, approved: planFm?.status === "approved" },
      tasks: { generated: tasksOk, approved: tasksFm?.status === "approved" },
    },
    ready_for_implementation: phase === "ready",
  }
}

export async function syncFrontmatterFromSpecJson(
  featureDir: string,
  sj: SpecJson,
  extra?: { last_audit?: AuditMetadata },
): Promise<void> {
  const specPath = path.join(featureDir, "spec.md")
  const planPath = path.join(featureDir, "plan.md")
  const tasksPath = path.join(featureDir, "tasks.md")

  const specExists = await fs.access(specPath).then(() => true).catch(() => false)
  const planExists = await fs.access(planPath).then(() => true).catch(() => false)
  const tasksExists = await fs.access(tasksPath).then(() => true).catch(() => false)

  if (specExists) {
    const existing = await readFrontmatter(specPath)
    await writeFrontmatter(specPath, {
      ...existing,
      feature_name: sj.feature_name,
      feature_number: sj.feature_number,
      created_at: sj.created_at,
      updated_at: sj.updated_at,
      phase: sj.phase,
      status: sj.approvals.spec.approved ? "approved" : sj.approvals.spec.generated ? "validated" : "generated",
      ...(extra?.last_audit ? { last_audit: extra.last_audit } : {}),
    })
  }

  if (planExists) {
    const existing = await readFrontmatter(planPath)
    await writeFrontmatter(planPath, {
      ...existing,
      phase: sj.phase === "plan" || sj.phase === "tasks" || sj.phase === "ready" || sj.phase === "impl" || sj.phase === "complete" ? "plan" : sj.phase,
      status: sj.approvals.plan.approved ? "approved" : sj.approvals.plan.generated ? "validated" : "generated",
      ...(extra?.last_audit ? { last_audit: extra.last_audit } : {}),
    })
  }

  if (tasksExists) {
    const existing = await readFrontmatter(tasksPath)
    await writeFrontmatter(tasksPath, {
      ...existing,
      phase: sj.phase === "tasks" || sj.phase === "ready" || sj.phase === "impl" || sj.phase === "complete" ? "tasks" : sj.phase,
      status: sj.approvals.tasks.approved ? "approved" : sj.approvals.tasks.generated ? "validated" : "generated",
      ...(extra?.last_audit ? { last_audit: extra.last_audit } : {}),
    })
  }
}

export async function writeFrontmatterChecksum(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const checksum = computeBodyChecksum(content)
    await writeFrontmatter(filePath, { checksum })
  } catch {
    // fail silently
  }
}
