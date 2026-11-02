import { describe, it, expect, afterEach } from "vitest"
import path from "node:path"
import { makeAttackRepo, destroyAttackRepo } from "../helpers/corpus"
import { createSandbox, destroySandbox } from "../../lab/core/sandbox"
import { readRegistry, writeRegistry } from "../../lab/core/registry"
import { labPaths } from "../../lab/core/home"
import { readLabAudit } from "../../lab/core/audit"
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_LIBRARY,
  describeProvider,
  isSandboxProviderId,
} from "../../lab/core/provider"
import {
  defaultSandboxPolicy,
  sanitizeSandboxPolicy,
} from "../../lab/core/types"
import type { LabRegistry, LabSandbox } from "../../lab/core/types"

let project: string | null = null

afterEach(async () => {
  if (project) {
    await destroyAttackRepo(project)
    project = null
  }
})

function bareEntry(projectRoot: string, id: string): LabSandbox {
  return {
    id,
    projectRoot,
    repoRoot: projectRoot,
    sandboxRoot: path.join(labPaths(projectRoot).sandboxes, id),
    adapter: "node",
    provider: "worktree",
    trust: "trusted",
    policy: defaultSandboxPolicy(),
    baseCommit: "0".repeat(40),
    createdAt: new Date().toISOString(),
    status: "active",
    warnings: [],
  }
}

describe("lab provider contract", () => {
  it("keeps the worktree provider always available and transparent", () => {
    const provider = PROVIDER_LIBRARY.worktree
    expect(provider.availability()).toEqual({ available: true, reason: "git worktrees need no extra tooling" })
    const wrapped = provider.wrap("node", ["--version"], { cwd: "/tmp" })
    expect(wrapped).toEqual({ command: "node", args: ["--version"] })
  })

  it("reports every unwired provider as unavailable instead of pretending", () => {
    for (const id of ["os-sandbox", "container", "vm"] as const) {
      const availability = PROVIDER_LIBRARY[id].availability()
      expect(availability.available).toBe(false)
      expect(availability.reason).toContain("not wired")
    }
  })

  it("refuses to wrap a command through an unwired provider", () => {
    for (const id of ["os-sandbox", "container", "vm"] as const) {
      expect(() => PROVIDER_LIBRARY[id].wrap("node", [], { cwd: "/tmp" })).toThrow(/not wired/)
    }
  })

  it("recognizes only the four library ids as providers", () => {
    expect(isSandboxProviderId("worktree")).toBe(true)
    expect(isSandboxProviderId("vm")).toBe(true)
    expect(isSandboxProviderId("hypervisor")).toBe(false)
    expect(isSandboxProviderId(7)).toBe(false)
    expect(DEFAULT_PROVIDER_ID).toBe("worktree")
    expect(describeProvider("worktree")).toContain("worktree")
  })
})

describe("lab sandbox policy validation", () => {
  it("falls back to the safe defaults when no policy was stored", () => {
    expect(sanitizeSandboxPolicy(undefined)).toEqual(defaultSandboxPolicy())
    expect(defaultSandboxPolicy().network).toBe("none")
    expect(defaultSandboxPolicy().secrets).toBe("none")
    expect(defaultSandboxPolicy().offline).toBe(false)
  })

  it("rejects a stored policy that widens any field", () => {
    expect(() => sanitizeSandboxPolicy({ network: "wide" })).toThrow(/network/)
    expect(() => sanitizeSandboxPolicy({ secrets: "all" })).toThrow(/secrets/)
    expect(() => sanitizeSandboxPolicy({ offline: "yes" })).toThrow(/offline/)
    expect(() => sanitizeSandboxPolicy({ registries: ["", "x"] })).toThrow(/registries/)
    expect(() => sanitizeSandboxPolicy("disabled")).toThrow(/object/)
  })

  it("keeps a fully specified stored policy", () => {
    const policy = sanitizeSandboxPolicy({
      network: "allowlist",
      networkAllow: ["registry.example"],
      secrets: "allowlist",
      secretsAllow: ["NPM_TOKEN"],
      offline: true,
      registries: ["registry.example"],
      containerImage: "node:20",
    })
    expect(policy.network).toBe("allowlist")
    expect(policy.networkAllow).toEqual(["registry.example"])
    expect(policy.secrets).toBe("allowlist")
    expect(policy.secretsAllow).toEqual(["NPM_TOKEN"])
    expect(policy.offline).toBe(true)
    expect(policy.registries).toEqual(["registry.example"])
    expect(policy.containerImage).toBe("node:20")
  })
})

describe("lab sandbox provider recording", () => {
  it("records the default provider trust and policy on a new sandbox", async () => {
    project = await makeAttackRepo()
    const sandbox = await createSandbox({ projectRoot: project as string, adapter: "node" })
    expect(sandbox.provider).toBe("worktree")
    expect(sandbox.trust).toBe("trusted")
    expect(sandbox.policy).toEqual(defaultSandboxPolicy())

    const audit = await readLabAudit(project as string)
    const created = audit.find((entry) => entry.kind === "lab_created" && entry.sandboxId === sandbox.id)
    expect(created?.isolationProvider).toBe("worktree")
    expect(created?.details).toMatchObject({ trust: "trusted" })
    await destroySandbox(project as string, sandbox, true)
  })

  it("records an explicit trust level on the sandbox and its audit trail", async () => {
    project = await makeAttackRepo()
    const sandbox = await createSandbox({
      projectRoot: project as string,
      adapter: "node",
      trust: "untrusted",
    })
    expect(sandbox.trust).toBe("untrusted")
    expect(sandbox.provider).toBe("worktree")
    const audit = await readLabAudit(project as string)
    const created = audit.find((entry) => entry.kind === "lab_created" && entry.sandboxId === sandbox.id)
    expect(created?.details).toMatchObject({ trust: "untrusted" })
    await destroySandbox(project as string, sandbox, true)
  })

  it("refuses to create a sandbox through a provider that is not wired yet", async () => {
    project = await makeAttackRepo()
    await expect(
      createSandbox({ projectRoot: project as string, adapter: "node", provider: "os-sandbox" }),
    ).rejects.toThrow(/unavailable/)
  })
})

describe("lab registry provider hydration", () => {
  it("hydrates entries written before the provider era with the worktree default", async () => {
    project = await makeAttackRepo()
    const entry = bareEntry(project as string, "legacy-sandbox")
    const legacy = { ...entry } as Partial<LabSandbox>
    delete legacy.provider
    delete legacy.trust
    delete legacy.policy
    await writeRegistry(project as string, {
      version: 1,
      sandboxes: [legacy as LabSandbox],
    } satisfies LabRegistry)

    const registry = await readRegistry(project as string)
    const stored = registry.sandboxes.find((item) => item.id === "legacy-sandbox")
    expect(stored?.provider).toBe("worktree")
    expect(stored?.trust).toBe("trusted")
    expect(stored?.policy).toEqual(defaultSandboxPolicy())
  })

  it("rejects a registry entry that claims an unknown provider", async () => {
    project = await makeAttackRepo()
    const entry = { ...bareEntry(project as string, "tampered"), provider: "hypervisor" } as unknown as LabSandbox
    await writeRegistry(project as string, { version: 1, sandboxes: [entry] } satisfies LabRegistry)
    await expect(readRegistry(project as string)).rejects.toThrow(/unknown provider/)
  })

  it("rejects a registry entry that claims an unknown trust level", async () => {
    project = await makeAttackRepo()
    const entry = { ...bareEntry(project as string, "tampered"), trust: "curious" } as unknown as LabSandbox
    await writeRegistry(project as string, { version: 1, sandboxes: [entry] } satisfies LabRegistry)
    await expect(readRegistry(project as string)).rejects.toThrow(/unknown trust/)
  })

  it("rejects a registry entry whose policy would widen access", async () => {
    project = await makeAttackRepo()
    const entry = {
      ...bareEntry(project as string, "tampered"),
      policy: { ...defaultSandboxPolicy(), network: "wide" },
    } as unknown as LabSandbox
    await writeRegistry(project as string, { version: 1, sandboxes: [entry] } satisfies LabRegistry)
    await expect(readRegistry(project as string)).rejects.toThrow(/network/)
  })
})
