import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareSandboxPermissions, verifyDirectoryUsable } from "../../lab/core/permissions"

const currentUid = typeof process.getuid === "function" ? process.getuid() : -1
const rootOwnedByProcess = process.platform !== "win32" && currentUid === 0

describe("corpus permission modes", () => {
  it("prepares a fresh directory so the lab can write and execute inside it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-perm-"))
    try {
      const dir = path.join(root, "sandbox")
      await prepareSandboxPermissions(dir)
      await verifyDirectoryUsable(dir, true)
      await fs.writeFile(path.join(dir, "marker.txt"), "ok")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("locks a prepared directory to the owning user with mode 0700", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-perm-"))
    try {
      const dir = path.join(root, "sandbox")
      await prepareSandboxPermissions(dir)
      const stat = await fs.stat(dir)
      expect(stat.mode & 0o777).toBe(0o700)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32" || rootOwnedByProcess)("refuses a directory whose rights were stripped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-perm-"))
    const dir = path.join(root, "sandbox")
    try {
      await prepareSandboxPermissions(dir)
      await fs.chmod(dir, 0o000)
      await expect(verifyDirectoryUsable(dir, true)).rejects.toThrow("executable and writable")
    } finally {
      await fs.chmod(dir, 0o700)
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a path that is not a directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-perm-"))
    try {
      const file = path.join(root, "plain.txt")
      await fs.writeFile(file, "x")
      await expect(verifyDirectoryUsable(file, false)).rejects.toThrow("non directory")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("keeps the directory writable after preparation because inherited acls carry isolation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-perm-"))
    try {
      const dir = path.join(root, "sandbox")
      await prepareSandboxPermissions(dir)
      await fs.access(dir, fs.constants.W_OK | fs.constants.R_OK | fs.constants.X_OK)
      const stat = await fs.stat(dir)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("corpus case sensitivity", () => {
  it.skipIf(process.platform === "win32")("treats a differently cased name as a missing file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-case-"))
    try {
      await fs.writeFile(path.join(root, "Marker.txt"), "pos")
      await expect(fs.readFile(path.join(root, "marker.txt"), "utf-8")).rejects.toThrow("ENOENT")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("resolves a differently cased name to the same file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-case-"))
    try {
      await fs.writeFile(path.join(root, "Marker.txt"), "same")
      expect(await fs.readFile(path.join(root, "marker.txt"), "utf-8")).toBe("same")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("corpus ownership", () => {
  it.skipIf(process.platform === "win32")("keeps every prepared path owned by the process user", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-owner-"))
    try {
      const dir = path.join(root, "sandbox")
      await prepareSandboxPermissions(dir)
      await fs.writeFile(path.join(dir, "marker.txt"), "ok")
      const dirStat = await fs.stat(dir)
      const fileStat = await fs.stat(path.join(dir, "marker.txt"))
      expect(dirStat.uid).toBe(currentUid)
      expect(fileStat.uid).toBe(currentUid)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
