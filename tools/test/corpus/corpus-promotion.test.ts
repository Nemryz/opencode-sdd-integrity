import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSandbox, destroySandbox, loadSandbox } from "../../lab/core/sandbox"
import { promoteDiff, reviewDiff } from "../../lab/core/diff"
import { readRegistry, writeRegistry } from "../../lab/core/registry"
import { ensureDependencies } from "../../lab/core/dependencies"
import { labPaths } from "../../lab/core/home"
import { makeAttackRepo, destroyAttackRepo, git, ensureAttackLabHome } from "../helpers/corpus"
import type { LabSandbox } from "../../lab/core/types"

let repo: string | null = null
let sandboxId: string | null = null

afterEach(async () => {
  if (sandboxId && repo) {
    const registry = await readRegistry(repo).catch(() => null)
    const entry = registry?.sandboxes.find((candidate) => candidate.id === sandboxId)
    if (entry && entry.status === "active") await destroySandbox(repo, entry, true).catch(() => null)
    sandboxId = null
  }
  if (repo) {
    await destroyAttackRepo(repo)
    repo = null
  }
})

function writeTimedPatch(): string {
  return [
    "diff --git a/out.txt b/out.txt",
    "--- a/out.txt",
    "+++ b/../../../host-escaped.txt",
    "@@ -0,0 +1 @@",
    "+host escape attempt\n",
  ].join("\n")
}

describe("corpus malicious patch", () => {
  it("rejects a patch that carries traversal targets and leaves the checkout files intact", async () => {
    repo = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    sandboxId = sandbox.id
    const patchDir = labPaths(repo).patches
    await fs.mkdir(patchDir, { recursive: true })
    const patchPath = path.join(patchDir, "attack.patch")
    await fs.writeFile(patchPath, writeTimedPatch(), "utf-8")

    await expect(promoteDiff(repo, sandbox)).rejects.toThrow()
    const escaped = path.resolve(path.dirname(patchPath), "..", "..", "..", "host-escaped.txt")
    expect(await fs.access(path.resolve(escaped)).then(() => "exists", () => "missing")).toBe("missing")
    expect(await fs.readFile(path.join(repo, "README.md"), "utf-8")).toBe("base\n")
  })
})

describe("corpus registry tampering", () => {
  it("refuses a registry entry whose id or sandbox root was rewritten by another process", async () => {
    repo = await makeAttackRepo()
    await ensureAttackLabHome(repo)
    const registryFile = path.join(labPaths(repo).registry, "registry.json")
    const hostile = {
      version: 1,
      sandboxes: [
        {
          id: "one",
          projectRoot: repo,
          repoRoot: repo,
          sandboxRoot: path.join(repo, "elsewhere", "one"),
          adapter: "probe",
          baseCommit: "0".repeat(40),
          createdAt: new Date().toISOString(),
          status: "active",
          warnings: [],
        },
      ],
    }
    await fs.writeFile(registryFile, JSON.stringify(hostile, null, 2), "utf-8")

    await expect(readRegistry(repo)).rejects.toThrow(/outside/)
    await expect(loadSandbox(repo, "one")).rejects.toThrow()
  })

  it("blocks a destroyed and deleted sandbox path from being removed twice with a hostile marker", async () => {
    repo = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    sandboxId = sandbox.id
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-decoy-"))
    const registryFile = path.join(labPaths(repo).registry, "registry.json")
    const registry = await readRegistry(repo)
    registry.sandboxes[0] = { ...registry.sandboxes[0], sandboxRoot: path.join(hostDir, "decoy-sandbox") }
    await writeRegistry(repo, registry)

    await expect(destroySandbox(repo, registry.sandboxes[0], true)).rejects.toThrow(/outside|refusing/)
    expect(await fs.access(hostDir).then(() => "exists", () => "missing")).toBe("exists")
    await destroyAttackRepo(hostDir)
  })

  it("stops promotion when the registry entry lost its reviewed patch hash", async () => {
    repo = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    sandboxId = sandbox.id
    await fs.writeFile(path.join(sandbox.sandboxRoot, "work.txt"), "work\n", "utf-8")
    await reviewDiff(repo, sandbox)
    const registry = await readRegistry(repo)
    const tampered: LabSandbox = { ...registry.sandboxes[0] }
    delete tampered.lastDiffHash
    await writeRegistry(repo, { version: 1, sandboxes: [tampered] })

    await expect(promoteDiff(repo, tampered as LabSandbox)).rejects.toThrow()
    expect(await fs.readFile(path.join(repo, "README.md"), "utf-8")).toBe("base\n")
  })
})

describe("corpus lockfile tampering", () => {
  it("refuses a converging install when the sandbox lockfile no longer matches what was created", async () => {
    repo = await makeAttackRepo()
    const lockfile = {
      name: "lab-corpus-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "lab-corpus-fixture", version: "1.0.0" } },
    }
    await fs.writeFile(path.join(repo, "package-lock.json"), JSON.stringify(lockfile, null, 2), "utf-8")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-qm", "lockfile fixture"])

    const sandbox = await createSandbox({ projectRoot: repo, adapter: "probe" })
    sandboxId = sandbox.id
    const tampered = { ...lockfile, packages: { "": { name: "evil-rebase", version: "2.0.0" } } }
    await fs.writeFile(path.join(sandbox.sandboxRoot, "package-lock.json"), JSON.stringify(tampered, null, 2), "utf-8")

    await expect(
      ensureDependencies({ projectRoot: repo, sandbox, reportDir: path.join(labPaths(repo).reports, sandbox.id) }),
    ).rejects.toThrow()
    const registry = await readRegistry(repo)
    const entry = registry.sandboxes.find((candidate) => candidate.id === sandbox.id)
    expect(entry?.status).toBe("active")
  })
})
