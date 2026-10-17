import { describe, it, expect } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { MutationBatchesSchema } from "../../shared/schemas"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")

async function readRepoJson(relPath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, ...relPath.split("/")), "utf-8"))
}

async function existsInRepo(relPath: string): Promise<boolean> {
  return fs.stat(path.join(REPO_ROOT, ...relPath.split("/"))).then(() => true).catch(() => false)
}

// Reads the single source of truth so every assertion below talks about the same file CI consumes.
async function readBatches() {
  const parsed = MutationBatchesSchema.parse(await readRepoJson("mutation-batches.json"))
  return parsed.batches
}

describe("mutation batches: the file is the source of truth", () => {
  it("parses against the schema", async () => {
    const raw = await readRepoJson("mutation-batches.json")
    const result = MutationBatchesSchema.safeParse(raw)
    expect(result.success, "mutation-batches.json does not satisfy MutationBatchesSchema").toBe(true)
  })

  it("gives every batch a unique kebab case id and a description", async () => {
    const batches = await readBatches()
    const ids = batches.map((batch) => batch.id)
    expect(new Set(ids).size, "duplicate batch id").toBe(ids.length)
    for (const batch of batches) {
      expect(batch.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(batch.description.trim().length).toBeGreaterThan(10)
      expect(batch.mutate.length).toBeGreaterThan(0)
    }
  })

  it("assigns every mutated file to exactly one batch", async () => {
    const batches = await readBatches()
    const seen = new Map<string, string>()
    for (const batch of batches) {
      for (const file of batch.mutate) {
        expect(seen.has(file), `${file} is measured in two batches`).toBe(false)
        seen.set(file, batch.id)
      }
    }
    expect(seen.size).toBeGreaterThan(10)
  })

  it("only points at source files that exist", async () => {
    const batches = await readBatches()
    for (const batch of batches) {
      for (const file of batch.mutate) {
        expect(await existsInRepo(file), `batch ${batch.id} points at a missing file ${file}`).toBe(true)
      }
    }
  })

  it("covers stryker.conf.json exactly, because the two must never disagree", async () => {
    const batches = await readBatches()
    const fromBatches = batches.flatMap((batch) => batch.mutate).sort()
    const config = (await readRepoJson("stryker.conf.json")) as { mutate: string[] }
    expect(fromBatches).toEqual([...config.mutate].sort())
  })

  it("keeps the batches small enough that CI jobs finish", async () => {
    const batches = await readBatches()
    for (const batch of batches) {
      let lines = 0
      for (const file of batch.mutate) {
        const content = await fs.readFile(path.join(REPO_ROOT, ...file.split("/")), "utf-8")
        lines += content.split(/\r?\n/).length
      }
      expect(lines, `batch ${batch.id} mutates ${lines} lines, which is too slow for one CI job`).toBeLessThan(1200)
    }
  })
})

describe("mutation batches: the CI matrix reads the file instead of repeating it", () => {
  it("derives the matrix from mutation-batches.json", async () => {
    const workflow = await fs.readFile(path.join(REPO_ROOT, ".github", "workflows", "stryker.yml"), "utf-8")

    expect(workflow, "the workflow must read the source of truth").toContain("mutation-batches.json")
    expect(workflow, "the matrix must be built from the job output").toMatch(/fromJSON\(needs\.\w+\.outputs\.\w+\)/)
    expect(workflow, "the matrix must not enumerate batch ids by hand").not.toMatch(/shared-io|snapshot-paths|tools-flow/)
  })

  it("installs with npm ci because a drifted lockfile must fail the run", async () => {
    const workflow = await fs.readFile(path.join(REPO_ROOT, ".github", "workflows", "stryker.yml"), "utf-8")
    expect(workflow).toContain("npm ci")
    expect(workflow).not.toContain("npm install")
  })

  it("names each report artifact after the batch so results stay separable", async () => {
    const workflow = await fs.readFile(path.join(REPO_ROOT, ".github", "workflows", "stryker.yml"), "utf-8")
    expect(workflow).toMatch(/name:.*batch/)
  })
})

describe("mutation batches: the file stays out of the shipped surface", () => {
  it("is not published, because measuring the kit is a maintainer job", async () => {
    const pkg = (await readRepoJson("package.json")) as { files?: string[] }
    expect(pkg.files ?? []).not.toContain("mutation-batches.json")
    expect(pkg.files ?? []).not.toContain("stryker.conf.json")
  })

  it("is not copied by the install scripts", async () => {
    for (const script of ["install.sh", "install.ps1"]) {
      const content = await fs.readFile(path.join(REPO_ROOT, script), "utf-8")
      expect(content, `${script} must not install the mutation config`).not.toContain("mutation-batches")
    }
  })
})
