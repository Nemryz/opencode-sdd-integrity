import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { repoPath, mockContext, createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import { makeSpecJson, writeSpecJson } from "../../shared/types"
import evidenceTool from "../../speckit-evidence"
import auditTool, { type AuditFinding } from "../../speckit-audit"
import speckitTools from "../../plugins/speckit-tools"
import { blockMessage, warningMessage } from "../../plugins/speckit-doom-loop"
import { DEFAULT_CONFIG, isProtectedFile } from "../../plugins/speckit-guard"

const SHOWCASE = repoPath("docs", "showcase.md")
const DEMO = "001-showcase-demo"

// Git checks out the doc with CRLF on Windows runners, so assertions compare LF-normalized text.
async function readShowcase(): Promise<string> {
  return (await fs.readFile(SHOWCASE, "utf-8")).replace(/\r\n/g, "\n")
}

let worktree: string
let ctx: ReturnType<typeof mockContext>

beforeAll(async () => {
  worktree = await createTempWorktree()
  ctx = mockContext(worktree)
  const featureDir = path.join(worktree, "specs", DEMO)
  await fs.mkdir(featureDir, { recursive: true })
  await fs.writeFile(path.join(featureDir, "spec.md"), "# Spec: showcase demo\n", "utf-8")
  await fs.writeFile(
    path.join(featureDir, "tasks.md"),
    "# Tasks\n\n### T-001 Initialize\n\n### T-002 Models\n\n### T-003 API\n",
    "utf-8",
  )
  const specJson = makeSpecJson("showcase-demo", 1)
  specJson.phase = "impl"
  await writeSpecJson(specJson, featureDir)

  await evidenceTool.execute(
    { command: "record", task: "T-001", testCommand: "npx vitest run", exitCode: 0, featureDir: DEMO },
    ctx,
  )
  await evidenceTool.execute(
    { command: "record", task: "T-002", testCommand: "npx vitest run", exitCode: 1, featureDir: DEMO },
    ctx,
  )
})

afterAll(async () => {
  await destroyTempWorktree(worktree)
})

describe("showcase content", () => {
  it("keeps the advertised interface counts in sync with the repository", async () => {
    const doc = await readShowcase()
    const registered: Array<{ name: string }> = []
    await speckitTools.setup({
      location: { directory: worktree, project: { id: "showcase", directory: worktree, canonical: worktree } },
      tool: { transform: async (callback: (editor: unknown) => void) => callback({ add: (tool: unknown) => registered.push(tool as { name: string }) }) },
    } as never)

    const pluginCount = (await fs.readdir(repoPath("plugins"))).filter(file => file.endsWith(".ts")).length
    const skillCount = (await fs.readdir(repoPath("skills"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== "rules").length
    const commandCount = (await fs.readdir(repoPath("commands"))).filter(file => file.endsWith(".md")).length

    expect(doc).toContain(
      `${registered.length} typed tools, ${pluginCount} runtime plugins, ${skillCount} skills, ${commandCount} commands`,
    )
  })

  it("matches the captured evidence status output", async () => {
    const doc = await readShowcase()
    const status = await evidenceTool.execute({ command: "status", featureDir: DEMO }, ctx)

    expect(status.output).toBe(
      [
        "Evidence: 2/3 tasks covered (2 entries)",
        "  missing: T-003",
        "  failing latest: T-002 (npx vitest run, exit 1)",
      ].join("\n"),
    )
    expect(doc).toContain(`[${status.title}] ${status.output}`)
  })

  it("matches the captured evidence audit findings", async () => {
    const doc = await readShowcase()
    const result = await auditTool.execute({}, ctx)
    const findings = ((result.metadata?.findings ?? []) as AuditFinding[])
      .filter(finding => finding.category.startsWith("evidence-"))

    expect(findings).toHaveLength(2)
    for (const finding of findings) {
      const tag = finding.severity === "error" ? "ERR" : finding.severity === "warn" ? "WRN" : "INF"
      expect(doc).toContain(`[${tag}] ${finding.category}: ${finding.message}`)
    }
  })

  it("matches the captured doom loop messages", async () => {
    const doc = await readShowcase()

    expect(doc).toContain(warningMessage("bash", 3, 5))
    expect(doc).toContain(blockMessage("bash", 5))
  })

  it("matches the captured guard reason", async () => {
    const doc = await readShowcase()
    const target = `specs/${DEMO}/spec.json`
    const reason = isProtectedFile(target, DEFAULT_CONFIG)

    expect(reason).toBe("Always protected: spec.json")
    expect(doc).toContain(`Guard blocked protected file: ${target} (${reason})`)
  })

  it("matches the captured corrupt evidence refusal", async () => {
    const doc = await readShowcase()
    await fs.writeFile(path.join(worktree, "specs", DEMO, "evidence.json"), "{broken", "utf-8")
    const result = await evidenceTool.execute({ command: "status", featureDir: DEMO }, ctx)

    expect(result.output).toContain(
      "is corrupt or invalid. Refusing to overwrite it. Restore it from .opencode/backups or remove it manually.",
    )
    expect(doc).toContain(`Evidence file specs/${DEMO}/evidence.json is corrupt or invalid. Refusing to overwrite it.`)
  })
})
