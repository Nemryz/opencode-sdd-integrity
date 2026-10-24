import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempWorktree, destroyTempWorktree } from "../helpers/setup"
import {
  clearCorruptionWarnings,
  configPath,
  corruptionWarnings,
  DEFAULT_CONFIG,
  DEFAULT_SESSION,
  prepareSessionForWrite,
  prepareSpecJsonForWrite,
  readConfig,
  readConfigWithRestore,
  sessionPath,
  writeConfigWithBackup,
  writeFileChecksum,
  writeSession,
  writeSpecJson,
  type SDDConfig,
  type SessionState,
  type SpecJson,
} from "../../shared/types"

let root: string

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return { ...DEFAULT_SESSION, ...overrides }
}

function makeConfig(overrides: Partial<SDDConfig> = {}): SDDConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

function makeSpec(overrides: Partial<SpecJson> = {}): SpecJson {
  return {
    feature_name: "demo",
    feature_number: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    phase: "complete",
    approvals: {
      spec: { generated: true, approved: true },
      plan: { generated: true, approved: true },
      tasks: { generated: true, approved: true },
    },
    ready_for_implementation: true,
    active_delta: null,
    converged: true,
    ...overrides,
  }
}

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

beforeEach(async () => {
  clearCorruptionWarnings()
  root = await createTempWorktree()
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearCorruptionWarnings()
  await destroyTempWorktree(root)
})

describe("session and spec preparation", () => {
  it("caps session history to the newest twenty entries", () => {
    const history = Array.from({ length: 25 }, (_, index) => `entry-${index}`)
    const prepared = prepareSessionForWrite(makeSession({ history }))
    expect(prepared.history).toHaveLength(20)
    expect(prepared.history[0]).toBe("entry-5")
    expect(prepared.history[19]).toBe("entry-24")
  })

  it("leaves a short session history untouched", () => {
    const prepared = prepareSessionForWrite(makeSession({ history: ["one", "two"] }))
    expect(prepared.history).toEqual(["one", "two"])
  })

  it("rejects a session that fails schema validation", () => {
    expect(() => prepareSessionForWrite(makeSession({ phase: "invalid" as never })))
      .toThrow(/writeSession: validation failed/)
  })

  it("stamps a spec and rejects an invalid phase", () => {
    const prepared = prepareSpecJsonForWrite(makeSpec(), new Date("2026-02-03T04:05:06.000Z"))
    expect(prepared.updated_at).toBe("2026-02-03T04:05:06.000Z")
    expect(() => prepareSpecJsonForWrite(makeSpec({ phase: "invalid" as never })))
      .toThrow(/writeSpecJson: validation failed/)
  })

  it("mutates the caller session history after capping", async () => {
    const history = Array.from({ length: 22 }, (_, index) => `entry-${index}`)
    const session = makeSession({ history })
    await writeSession(root, session)
    expect(session.history).toHaveLength(20)
    expect(session.history[0]).toBe("entry-2")
  })
})

describe("state file recovery", () => {
  it("repairs a mismatched checksum when a valid config is read", async () => {
    await write(".opencode/spec-memory/config.json", JSON.stringify(makeConfig({ lastUsedLanguage: "es" })))
    await write(".opencode/spec-memory/config.json.sha256", "0".repeat(64))
    const config = await readConfig(root)
    expect(config.lastUsedLanguage).toBe("es")
    expect(await fs.readFile(`${configPath(root)}.sha256`, "utf-8")).toMatch(/^[a-f0-9]{64}$/)
    expect(await fs.readFile(`${configPath(root)}.sha256`, "utf-8")).not.toBe("0".repeat(64))
  })

  it("repairs a mismatched checksum from the restoring reader", async () => {
    await write(".opencode/spec-memory/config.json", JSON.stringify(makeConfig({ lastUsedLanguage: "fr" })))
    await write(".opencode/spec-memory/config.json.sha256", "0".repeat(64))
    const config = await readConfigWithRestore(root)
    expect(config.lastUsedLanguage).toBe("fr")
    expect(await fs.readFile(`${configPath(root)}.sha256`, "utf-8")).toMatch(/^[a-f0-9]{64}$/)
    expect(await fs.readFile(`${configPath(root)}.sha256`, "utf-8")).not.toBe("0".repeat(64))
  })

  it("rejects an invalid config before writing it", async () => {
    await expect(writeConfigWithBackup(root, { ...makeConfig(), expressMode: "yes" } as unknown as SDDConfig))
      .rejects.toThrow(/writeConfigWithBackup: validation failed/)
    await expect(fs.access(configPath(root))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports corruption and returns defaults for a bad config checksum", async () => {
    await write(".opencode/spec-memory/config.json", JSON.stringify(makeConfig()))
    await writeFileChecksum(configPath(root))
    await fs.writeFile(configPath(root), "corrupted", "utf-8")
    const config = await readConfig(root)
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(corruptionWarnings.some((entry) => entry.file === configPath(root))).toBe(true)
  })
})

describe("post-write verification", () => {
  it("fails session writes when the persisted JSON does not parse", async () => {
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, "readFile").mockImplementation(async (file, encoding) => {
      if (path.resolve(String(file)) === path.resolve(sessionPath(root))) {
        return JSON.stringify({ invalid: true }) as never
      }
      return original(file, encoding as never) as never
    })
    await expect(writeSession(root, makeSession())).rejects.toThrow(/post-write verification failed/)
  })

  it("fails session writes when the persisted checksum does not match", async () => {
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, "readFile").mockImplementation(async (file, encoding) => {
      if (String(file).endsWith(".sha256")) return "0".repeat(64) as never
      return original(file, encoding as never) as never
    })
    await expect(writeSession(root, makeSession())).rejects.toThrow(/post-write checksum verification failed/)
  })

  it("fails spec writes when the persisted JSON does not parse", async () => {
    const featureDir = path.join(root, "specs", "001-demo")
    await fs.mkdir(featureDir, { recursive: true })
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, "readFile").mockImplementation(async (file, encoding) => {
      if (path.resolve(String(file)) === path.resolve(featureDir, "spec.json")) {
        return JSON.stringify({ invalid: true }) as never
      }
      return original(file, encoding as never) as never
    })
    await expect(writeSpecJson(makeSpec(), featureDir)).rejects.toThrow(/post-write verification failed/)
  })

  it("fails spec writes when the persisted checksum does not match", async () => {
    const featureDir = path.join(root, "specs", "001-demo")
    await fs.mkdir(featureDir, { recursive: true })
    const original = fs.readFile.bind(fs)
    vi.spyOn(fs, "readFile").mockImplementation(async (file, encoding) => {
      if (String(file).endsWith(".sha256")) return "0".repeat(64) as never
      return original(file, encoding as never) as never
    })
    await expect(writeSpecJson(makeSpec(), featureDir)).rejects.toThrow(/post-write checksum verification failed/)
  })
})
