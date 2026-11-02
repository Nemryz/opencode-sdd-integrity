import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  LabPathError,
  assertInsideWorkspace,
  assertRealInsideWorkspace,
  insideWorkspace,
  resolveInside,
  safeSegment,
} from "../../lab/core/paths"
import { labPaths } from "../../lab/core/home"

describe("corpus path traversal", () => {
  it.skipIf(process.platform === "win32")("rejects backslash traversal candidates on POSIX", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      expect(() => resolveInside(workspace, "..\\host.txt")).toThrow(LabPathError)
      expect(() => assertInsideWorkspace(workspace, "..\\host.txt")).toThrow(LabPathError)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  it("rejects absolute candidates, control characters and escape attempts written by tools", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      expect(() => resolveInside(workspace, path.join(os.tmpdir(), "absolute.txt"))).toThrow(LabPathError)
      expect(() => resolveInside(workspace, "a\n../b")).toThrow(LabPathError)
      expect(() => resolveInside(workspace, "")).toThrow(LabPathError)
      expect(() => resolveInside(workspace, ".")).toThrow(LabPathError)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  it("keeps a resolved candidate pinned under the workspace even after a traversal attempt", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      const resolved = resolveInside(workspace, "docs/../src/file.ts")
      expect(resolved.startsWith(path.resolve(workspace) + path.sep)).toBe(true)
      expect(resolved).toBe(path.resolve(workspace, "src", "file.ts"))
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("corpus symlink escape", () => {
  it.skipIf(process.platform === "win32")("refuses a sandbox path that is a symlink aimed back at the host", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    const hostFile = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-host-"))
    try {
      await fs.writeFile(path.join(hostFile, "host.txt"), "host\n", "utf-8")
      const attackerDir = path.join(workspace, "inside")
      await fs.mkdir(attackerDir, { recursive: true })
      await fs.symlink(path.join(hostFile, "host.txt"), path.join(attackerDir, "link.txt"))

      await expect(assertRealInsideWorkspace(workspace, path.join("inside", "link.txt"))).rejects.toThrow(/outside/)
      await expect(assertRealInsideWorkspace(workspace, path.join("inside/link.txt"))).rejects.toThrow(/outside/)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(hostFile, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("keeps a symlink that resolves inside the workspace usable while still resolving the real target", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      const realDir = path.join(workspace, "real")
      await fs.mkdir(realDir, { recursive: true })
      await fs.writeFile(path.join(realDir, "target.txt"), "target\n", "utf-8")
      await fs.symlink(realDir, path.join(workspace, "alias"))
      const real = await assertRealInsideWorkspace(workspace, path.join("alias", "target.txt"))
      expect(real).toBe(path.join(realDir, "target.txt"))
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("corpus hardlink snapshot", () => {
  it("breaks the hardlink survival when the lab copies the file into a sandbox", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-host-"))
    try {
      const hostFile = path.join(hostDir, "host-marker.txt")
      const insideFile = path.join(workspace, "sandbox-marker.txt")
      await fs.writeFile(hostFile, "host content\n", "utf-8")
      await fs.link(hostFile, insideFile)
      const linked = await fs.stat(insideFile)
      const original = await fs.stat(hostFile)
      expect(linked.ino).toBe(original.ino)

      const copiedTo = path.join(workspace, "copy-marker.txt")
      await fs.copyFile(insideFile, copiedTo)
      const copied = await fs.stat(copiedTo)
      expect(copied.ino).not.toBe(original.ino)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(hostDir, { recursive: true, force: true })
    }
  })
})

describe("corpus toctou window", () => {
  it.skipIf(process.platform === "win32")("re resolves the real path at the moment of use so a swapped link falls back to a hard error", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-host-"))
    try {
      await fs.writeFile(path.join(hostDir, "late.txt"), "late host\n", "utf-8")
      const inner = path.join(workspace, "inner")
      await fs.mkdir(inner, { recursive: true })
      await fs.writeFile(path.join(workspace, "innocent.txt"), "innocent\n", "utf-8")
      const candidate = path.join("inner", "moved.txt")
      await fs.symlink(path.join(workspace, "innocent.txt"), path.join(inner, "moved.txt"))
      const firstReal = await assertRealInsideWorkspace(workspace, candidate)
      expect(firstReal).toBe(path.resolve(workspace, "innocent.txt"))

      // The attacker now swings the same path towards the host file.
      await fs.rm(path.join(inner, "moved.txt"))
      await fs.symlink(path.join(hostDir, "late.txt"), path.join(inner, "moved.txt"))
      await expect(assertRealInsideWorkspace(workspace, candidate)).rejects.toThrow(/outside/)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(hostDir, { recursive: true, force: true })
    }
  })
})

describe("corpus ambiguous paths", () => {
  it("rejects segments with surrounding whitespace or a trailing dot", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      expect(() => resolveInside(workspace, "a /b")).toThrow(LabPathError)
      expect(() => resolveInside(workspace, "dir.")).toThrow(LabPathError)
      expect(() => resolveInside(workspace, "a /b")).toThrow(LabPathError)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  it("keeps a normal directory from being mistaken for a reparse point", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-ws-"))
    try {
      const dir = path.join(workspace, "normal")
      await fs.mkdir(dir, { recursive: true })
      const real = await assertRealInsideWorkspace(workspace, "normal")
      expect(real).toBe(await fs.realpath(dir))
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("corpus sandbox containment", () => {
  it("keeps the lab home under the project and matches only paths inside its sandbox tree", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-repo-"))
    try {
      const layout = labPaths(repo)
      expect(layout.home.startsWith(path.resolve(repo))).toBe(true)
      const id = safeSegment("20261101000000-abc")
      expect(id).toBe("20261101000000-abc")
      expect(() => safeSegment("../escape")).toThrow()
      expect(() => safeSegment("abc.")).toThrow()
      expect(() => safeSegment("sub/dir")).toThrow()
      expect(() => safeSegment(".")).toThrow()
      expect(() => safeSegment('ev"il')).toThrow()
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it("throws a lab path error rather than a generic one when a guard fails", async () => {
    expect(() => insideWorkspace("/tmp", "/etc/passwd")).toThrow(LabPathError)
  })
})

describe("corpus windows reserved device names", () => {
  it.each([
    "CON",
    "CON.txt",
    "con",
    "aux",
    "AUX.log",
    "NUL",
    "nul.tar.gz",
    "COM1",
    "com9",
    "LPT1",
    "lpt7",
    "nested/prn",
    "deep/vector/COM4.out",
  ])("rejects the reserved device name %s before any filesystem use", (candidate) => {
    expect(() => resolveInside(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => assertInsideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => insideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
  })

  it("refuses ids that name a reserved Windows device", () => {
    expect(() => safeSegment("con")).toThrow(LabPathError)
    expect(() => safeSegment("NUL.txt")).toThrow(LabPathError)
    expect(() => safeSegment("LPT3")).toThrow(LabPathError)
  })
})

describe("corpus windows drive letters and UNC targets", () => {
  it.each([
    "C:",
    "D:/host.txt",
    "e:marker.txt",
    "nested/F:/leak.txt",
  ])("rejects the drive letter path %s because it is absolute on Windows", (candidate) => {
    expect(() => resolveInside(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => assertInsideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => insideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
  })

  it.each([
    "//server/share/payload",
    "\\\\server\\share\\payload",
  ])("rejects the UNC path %s everywhere", (candidate) => {
    expect(() => resolveInside(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => assertInsideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
    expect(() => insideWorkspace(os.tmpdir(), candidate)).toThrow(LabPathError)
  })
})

describe("corpus windows accepted shapes", () => {
  it.runIf(process.platform === "win32")("normalizes backslash separators so the same fragment list is guarded", () => {
    const resolved = resolveInside(os.tmpdir(), "a\\b\\file.txt")
    expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true)
    expect(insideWorkspace(os.tmpdir(), "a\\b\\file.txt")).toBe(path.resolve(os.tmpdir(), "a", "b", "file.txt"))
  })

  it.runIf(process.platform === "win32")("keeps a differently cased directory inside the workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-casing-"))
    try {
      const dir = path.join(workspace, "Casing")
      await fs.mkdir(dir)
      expect(() => resolveInside(workspace, "Casing")).not.toThrow()
      await expect(assertRealInsideWorkspace(workspace, "casing")).resolves.toBe(await fs.realpath(dir))
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("corpus windows junctions", () => {
  it.runIf(process.platform === "win32")("rejects a junction that is the final component and aims outside", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-junction-ws-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-junction-out-"))
    try {
      await fs.symlink(outside, path.join(workspace, "jump"), "junction")
      await expect(assertRealInsideWorkspace(workspace, "jump")).rejects.toThrow(LabPathError)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("rejects a path that walks through a junction aimed outside", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-junction-ws-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-junction-out-"))
    try {
      await fs.mkdir(path.join(workspace, "mid"))
      await fs.writeFile(path.join(outside, "payload.txt"), "escape")
      await fs.symlink(outside, path.join(workspace, "mid", "out"), "junction")
      await expect(assertRealInsideWorkspace(workspace, "mid/out/payload.txt")).rejects.toThrow(LabPathError)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "win32")("keeps a junction that stays inside the workspace usable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-junction-ws-"))
    try {
      const real = path.join(workspace, "real")
      await fs.mkdir(real)
      await fs.symlink(real, path.join(workspace, "jump"), "junction")
      await expect(assertRealInsideWorkspace(workspace, "jump")).resolves.toBe(await fs.realpath(real))
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})
