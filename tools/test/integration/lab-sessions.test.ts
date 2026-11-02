import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { createTempWorktree, destroyTempWorktree, repoRootDir } from "../helpers/setup"
import { createSandbox, destroySandbox } from "../../lab/core/sandbox"
import { readRegistry } from "../../lab/core/registry"
import {
  appendSessionAudit,
  checkpointFile,
  createCheckpoint,
  createSession,
  getSession,
  listSessions,
  latestCheckpoint,
  latestSession,
  pruneSessions,
  readCheckpoints,
  readSessionAudit,
  readSessions,
  resumeSession,
  sessionAuditFile,
  sessionDir,
  updateSession,
  verifyCheckpoint,
} from "../../lab/core/session"
import { readLabAudit } from "../../lab/core/audit"
import { removeWorktree } from "../../lab/core/git"
import type { LabSandbox } from "../../lab/core/types"

let repo: string
let sandbox: LabSandbox

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

async function writeSandboxFile(relative: string, content: string): Promise<void> {
  const file = path.join(sandbox.sandboxRoot, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf-8")
}

beforeEach(async () => {
  repo = await createTempWorktree()
  git(["init", "-q"])
  git(["config", "user.email", "lab@example.com"])
  git(["config", "user.name", "Lab Tester"])
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "lab-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2),
    "utf-8",
  )
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf-8")
  git(["add", "-A"])
  git(["commit", "-m", "base"])
  sandbox = await createSandbox({ projectRoot: repo, adapter: "integrity" })
})

afterEach(async () => {
  const registry = await readRegistry(repo).catch(() => null)
  for (const entry of registry?.sandboxes ?? []) {
    if (entry.status !== "destroyed") {
      await removeWorktree(entry.repoRoot, entry.sandboxRoot).catch(() => null)
    }
  }
  await destroyTempWorktree(repo)
})

describe("lab sessions registry", () => {
  it("opens a session only for a registered live sandbox and records an audit trail", async () => {
    await expect(createSession({ projectRoot: repo, sandboxId: "missing" })).rejects.toThrow(
      /is not registered, so no session can point at it/,
    )

    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id, label: "demo" })
    expect(session.status).toBe("active")
    expect(session.checkpointCount).toBe(0)
    expect(session.warnings).toEqual([])
    expect(session.label).toBe("demo")
    expect(session.projectRoot).toBe(repo)

    // The session keeps its own guarded directory next to the other lab state.
    const dir = sessionDir(repo, session.id)
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(dir, "checkpoints"))).mode & 0o777).toBe(0o700)

    const registry = await readSessions(repo)
    expect(registry.sessions).toHaveLength(1)
    expect(registry.sessions[0].id).toBe(session.id)
    expect(await listSessions(repo)).toHaveLength(1)

    const audit = await readLabAudit(repo)
    const created = audit.filter((entry) => entry.kind === "lab_session_created")
    expect(created).toHaveLength(1)
    expect(created[0].details?.sessionId).toBe(session.id)
    expect(created[0].details?.trust).toBe("trusted")
  })

  it("refuses to open a session for a destroyed sandbox", async () => {
    await destroySandbox(repo, sandbox, true)
    await expect(createSession({ projectRoot: repo, sandboxId: sandbox.id })).rejects.toThrow(
      /was destroyed, so a new sandbox is needed/,
    )
  })

  it("round trips updates under lock and resolves the latest active session", async () => {
    const first = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const second = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    expect(first.id).not.toBe(second.id)

    const updated = await updateSession(repo, second.id, { label: "picked" })
    expect(updated?.label).toBe("picked")
    expect((await getSession(repo, second.id))?.label).toBe("picked")
    expect(await updateSession(repo, "missing", { label: "x" })).toBeNull()

    expect((await latestSession(repo))?.id).toBe(second.id)
    await updateSession(repo, second.id, { status: "closed" })
    expect((await latestSession(repo))?.id).toBe(first.id)
  })

  it("fails loud when the session registry is corrupted", async () => {
    await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const file = path.join(repo, ".opencode", "lab", "sessions", "registry.json")
    const parsed = JSON.parse(await fs.readFile(file, "utf-8"))
    parsed.sessions[0].status = "exploded"
    await fs.writeFile(file, JSON.stringify(parsed), "utf-8")
    await expect(readSessions(repo)).rejects.toThrow(/carries an unknown status/)

    parsed.sessions[0].status = "active"
    parsed.sessions[0].id = "../escape"
    await fs.writeFile(file, JSON.stringify(parsed), "utf-8")
    await expect(readSessions(repo)).rejects.toThrow(/carries an unsafe id/)
  })
})

describe("lab checkpoints", () => {
  it("freezes HEAD plus the patch hash into a numbered immutable checkpoint", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await writeSandboxFile("README.md", "dirty for checkpoint\n")

    const checkpoint = await createCheckpoint(repo, session.id, { note: "before refactor" })

    expect(checkpoint.index).toBe(1)
    expect(checkpoint.sandboxHead).toBe(sandbox.baseCommit)
    expect(checkpoint.patchHash).toHaveLength(64)
    expect(checkpoint.note).toBe("before refactor")
    expect(checkpoint.integrity).toHaveLength(64)

    const file = checkpointFile(repo, session.id, 1)
    const stored = JSON.parse(await fs.readFile(file, "utf-8"))
    expect(stored.patchHash).toBe(checkpoint.patchHash)
    // Checkpoints are read only on disk, so a stray write must fail instead of rewriting history.
    await expect(fs.writeFile(file, "{}", "utf-8")).rejects.toThrow(/EACCES|EPERM/)

    await expect(verifyCheckpoint(repo, session.id, 1)).resolves.toMatchObject({ patchHash: checkpoint.patchHash })
    const sessionUpdated = await getSession(repo, session.id)
    expect(sessionUpdated?.checkpointCount).toBe(1)
    expect(sessionUpdated?.lastCheckpointAt).toBe(checkpoint.createdAt)
  })
})

describe("lab checkpoint ordering and verification", () => {
  it("increments indices, verifies every stored checkpoint and rejects tampering", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const first = await createCheckpoint(repo, session.id)
    await writeSandboxFile("extra.txt", "second change\n")
    const second = await createCheckpoint(repo, session.id, { runId: "run-42" })

    expect(second.index).toBe(2)
    expect(second.patchHash).not.toBe(first.patchHash)
    expect(second.runId).toBe("run-42")

    const stored = await readCheckpoints(repo, session.id)
    expect(stored.map((entry) => entry.index)).toEqual([1, 2])
    expect(await latestCheckpoint(repo, session.id)).toMatchObject({ index: 2 })

    const file = checkpointFile(repo, session.id, 1)
    await fs.chmod(file, 0o600)
    const tampered = JSON.parse(await fs.readFile(file, "utf-8"))
    tampered.patchHash = crypto.randomBytes(32).toString("hex")
    await fs.writeFile(file, JSON.stringify(tampered), "utf-8")

    await expect(readCheckpoints(repo, session.id)).rejects.toThrow(/failed its integrity check/)
    await expect(latestCheckpoint(repo, session.id)).rejects.toThrow(/failed its integrity check/)
    await expect(verifyCheckpoint(repo, session.id, 1)).rejects.toThrow(/failed its integrity check/)
    await expect(verifyCheckpoint(repo, session.id, 9)).rejects.toThrow(/is missing/)

    const audit = await readLabAudit(repo)
    const checkpoints = audit.filter((entry) => entry.kind === "lab_checkpoint")
    expect(checkpoints.map((entry) => entry.details?.checkpointIndex)).toEqual([1, 2])
    expect(await getSession(repo, session.id)).toMatchObject({ checkpointCount: 2 })
  })

  it("refuses checkpoints for unknown, closed or destroyed targets", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })

    await expect(createCheckpoint(repo, "missing-session")).rejects.toThrow(/is not registered/)

    await updateSession(repo, session.id, { status: "closed" })
    await expect(createCheckpoint(repo, session.id)).rejects.toThrow(/is closed, so a checkpoint needs an active session/)

    await updateSession(repo, session.id, { status: "active" })
    await destroySandbox(repo, sandbox, true)
    await expect(createCheckpoint(repo, session.id)).rejects.toThrow(/was destroyed/)
  })
})

describe("lab resume", () => {
  it("resumes the latest session only after the sandbox proves the exact checkpointed state", async () => {
    const survivor = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const newest = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await updateSession(repo, newest.id, { status: "closed" })

    // An untouched sandbox holds an empty patch, so the recorded hash is the sha of nothing and resume still proves it.
    const checkpoint = await createCheckpoint(repo, survivor.id)
    expect(checkpoint.patchHash).toBe(crypto.createHash("sha256").update("").digest("hex"))

    const resumed = await resumeSession(repo)
    expect(resumed.session.id).toBe(survivor.id)
    expect(resumed.session.status).toBe("resumed")
    expect(resumed.sandbox.id).toBe(sandbox.id)
    expect(resumed.checkpoint.index).toBe(1)
    expect((await latestSession(repo))?.id).toBe(survivor.id)

    const audit = await readLabAudit(repo)
    const resumes = audit.filter((entry) => entry.kind === "lab_resume")
    expect(resumes).toHaveLength(1)
    expect(resumes[0].details?.sessionId).toBe(survivor.id)
    expect(resumes[0].details?.checkpointIndex).toBe(1)
  })

  it("refuses to resume a session without any checkpoint", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(/has no checkpoints yet/)
    expect((await getSession(repo, session.id))?.status).toBe("active")
  })

  it("refuses patch drift and accepts a fresh checkpoint over the new state", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, session.id)

    await writeSandboxFile("burst.txt", "work after checkpoint\n")
    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(
      /drifted from the patch recorded by checkpoint 1/,
    )

    await createCheckpoint(repo, session.id, { note: "captured burst" })
    const resumed = await resumeSession(repo, { sessionId: session.id })
    expect(resumed.checkpoint.index).toBe(2)
    expect(resumed.checkpoint.note).toBe("captured burst")
  })

  it("refuses HEAD drift caused by commits inside the sandbox", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, session.id)
    await writeSandboxFile("committed.txt", "committed inside sandbox\n")
    git(["-C", sandbox.sandboxRoot, "add", "-A"])
    git(["-C", sandbox.sandboxRoot, "commit", "-m", "sandbox commit"])

    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(
      /moved from commit .* to .* after the last checkpoint/,
    )
  })

  it("closes a session with a warning when its sandbox was destroyed or vanished", async () => {
    const destroyed = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, destroyed.id)
    await destroySandbox(repo, sandbox, true)
    await expect(resumeSession(repo, { sessionId: destroyed.id })).rejects.toThrow(
      /because sandbox .* was destroyed/,
    )
    expect(await getSession(repo, destroyed.id)).toMatchObject({ status: "closed" })

    const second = await createSandbox({ projectRoot: repo, adapter: "integrity" })
    const vanished = await createSession({ projectRoot: repo, sandboxId: second.id })
    await createCheckpoint(repo, vanished.id)
    await removeWorktree(second.repoRoot, second.sandboxRoot)
    // The physical directory is gone while the registry still says active, so resume has to catch it too.
    await expect(resumeSession(repo, { sessionId: vanished.id })).rejects.toThrow(/sandbox directory is missing on disk/)
    const closed = await getSession(repo, vanished.id)
    expect(closed?.status).toBe("closed")
    expect(closed?.warnings.some((warning) => warning.includes("missing on disk"))).toBe(true)
  })
})

describe("lab session chronology", () => {
  it("keeps an immutable per session audit file without parent environment details", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const checkpoint = await createCheckpoint(repo, session.id)
    await resumeSession(repo, { sessionId: session.id })

    const file = sessionAuditFile(repo, session.id)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o400)

    const records = await readSessionAudit(repo, session.id)
    expect(records.map((record) => record.kind)).toEqual(["lab_session_created", "lab_checkpoint", "lab_resume"])
    for (const record of records) {
      expect(record.sessionId).toBe(session.id)
      expect(record).not.toHaveProperty("env")
      expect(Object.keys(record.details ?? {})).not.toContain("PATH")
      expect(Object.keys(record.details ?? {})).not.toContain("cwd")
    }
    expect(records.find((record) => record.kind === "lab_checkpoint")?.details?.patchHash).toBe(checkpoint.patchHash)

    // The chronology is read only on disk, so history cannot be rewritten in place.
    await expect(fs.appendFile(file, '{"kind":"tampered"}\n', "utf-8")).rejects.toThrow(/EACCES|EPERM/)
  })

  it("closes the chronology with a warning record when resume proves the sandbox gone", async () => {
    const session = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, session.id)
    await destroySandbox(repo, sandbox, true)
    await expect(resumeSession(repo, { sessionId: session.id })).rejects.toThrow(/was destroyed/)

    const records = await readSessionAudit(repo, session.id)
    expect(records[records.length - 1]).toMatchObject({ kind: "lab_session_closed" })
    expect(String(records[records.length - 1].details?.warning)).toContain("was destroyed")
  })

  it("refuses to write a chronology line for an unregistered session", async () => {
    await expect(
      appendSessionAudit({
        kind: "lab_session_created",
        projectRoot: repo,
        sessionId: "ghost",
        when: new Date().toISOString(),
      }),
    ).rejects.toThrow(/is not registered, so its chronology cannot be written/)
  })
})

describe("lab session prune", () => {
  const corruptOne = async (id: string): Promise<void> => {
    const file = checkpointFile(repo, id, 1)
    await fs.chmod(file, 0o600)
    const raw = JSON.parse(await fs.readFile(file, "utf-8"))
    raw.sandboxHead = "edited by hand"
    await fs.writeFile(file, JSON.stringify(raw), "utf-8")
    await fs.chmod(file, 0o400)
  }

  it("dry runs a full candidate report over alive, dead, ghost and corrupt sessions", async () => {
    const healthy = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, healthy.id)

    const corrupt = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, corrupt.id)
    await corruptOne(corrupt.id)

    const second = await createSandbox({ projectRoot: repo, adapter: "integrity" })
    const dead = await createSession({ projectRoot: repo, sandboxId: second.id })
    await createCheckpoint(repo, dead.id)
    await destroySandbox(repo, second, true)

    const ghost = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await fs.rm(sessionDir(repo, ghost.id), { recursive: true, force: true })

    const dry = await pruneSessions({ projectRoot: repo })
    expect(dry.dryRun).toBe(true)
    const byId = new Map(dry.candidates.map((candidate) => [candidate.id, candidate]))
    expect(byId.get(corrupt.id)).toMatchObject({ reason: "corrupt", action: "remove-session" })
    expect(byId.get(dead.id)).toMatchObject({ reason: "dead-sandbox", action: "close-session" })
    expect(byId.get(ghost.id)).toMatchObject({ reason: "missing-directory", action: "close-session" })
    expect(byId.has(healthy.id)).toBe(false)

    // A later horizon only reclassifies the untouched history as expired while the dry run keeps every file.
    const future = new Date(Date.parse("2030-01-01T00:00:00.000Z"))
    const aged = await pruneSessions({ projectRoot: repo, now: future })
    expect(aged.candidates.every((candidate) => candidate.action === "remove-session")).toBe(true)
    expect((await readSessions(repo)).sessions).toHaveLength(4)
    expect(await fs.stat(sessionDir(repo, healthy.id))).toBeTruthy()
  })

  it("removes expired and corrupt sessions after confirmation", async () => {
    const expired = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, expired.id)

    const corrupt = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, corrupt.id)
    await corruptOne(corrupt.id)

    const future = new Date(Date.parse("2030-01-01T00:00:00.000Z"))
    const result = await pruneSessions({ projectRoot: repo, now: future, confirmed: true })
    expect(result.dryRun).toBe(false)
    expect(result.closed).toEqual([])
    expect([...result.removed].sort()).toEqual([corrupt.id, expired.id].sort())

    await expect(fs.stat(sessionDir(repo, expired.id))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.stat(sessionDir(repo, corrupt.id))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readSessions(repo)).sessions).toHaveLength(0)

    const audit = await readLabAudit(repo)
    const pruned = audit.filter((entry) => entry.kind === "lab_session_pruned")
    expect(pruned).toHaveLength(1)
    expect(pruned[0].details?.removed).toEqual([expired.id, corrupt.id].sort())
  })

  it("closes sessions whose sandbox died and refuses their later resume", async () => {
    const dead = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    await createCheckpoint(repo, dead.id)
    await destroySandbox(repo, sandbox, true)

    const result = await pruneSessions({ projectRoot: repo, confirmed: true })
    expect(result.closed).toEqual([dead.id])
    expect(result.removed).toEqual([])

    const survivor = await getSession(repo, dead.id)
    expect(survivor?.status).toBe("closed")
    expect(survivor?.warnings.some((warning) => warning.includes("was destroyed or lost its directory"))).toBe(true)

    await expect(resumeSession(repo, { sessionId: dead.id })).rejects.toThrow(/is closed, so it cannot resume/)
  })

  it("clears orphan session directories that no registry entry owns", async () => {
    const orphanName = "20260101-000000-orphan"
    await fs.mkdir(path.join(repo, ".opencode", "lab", "sessions", orphanName, "checkpoints"), { recursive: true })

    const mine = await createSession({ projectRoot: repo, sandboxId: sandbox.id })
    const result = await pruneSessions({ projectRoot: repo, confirmed: true })
    expect(result.orphanDirectories).toHaveLength(1)
    expect(result.orphanDirectories[0]).toContain(orphanName)
    expect(await fs.stat(sessionDir(repo, mine.id))).toBeTruthy()
    await expect(fs.stat(path.join(repo, ".opencode", "lab", "sessions", orphanName))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
