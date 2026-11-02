import { describe, it, expect, afterEach } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
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
  resolveProvider,
} from "../../lab/core/provider"
import {
  defaultSandboxPolicy,
  sanitizeSandboxPolicy,
} from "../../lab/core/types"
import type {
  LabRegistry,
  LabSandbox,
  ProviderAvailability,
  SandboxProvider,
  SandboxProviderId,
} from "../../lab/core/types"
import { readLabPolicy, setLabDisabled, labPolicyFile } from "../../lab/core/policy"
import { runLabProcess } from "../../lab/core/runner"

let project: string | null = null

afterEach(async () => {
  if (project) {
    await destroyAttackRepo(project)
    project = null
  }
})

// Builds a library whose availability answers come from the test instead of the host tooling.
function fakeLibrary(
  overrides: Partial<Record<SandboxProviderId, ProviderAvailability>>,
): Record<SandboxProviderId, SandboxProvider> {
  const library: Record<SandboxProviderId, SandboxProvider> = { ...PROVIDER_LIBRARY }
  for (const [id, availability] of Object.entries(overrides) as [SandboxProviderId, ProviderAvailability][]) {
    library[id] = { ...library[id], availability: () => availability }
  }
  return library
}

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
    for (const id of ["vm"] as const) {
      const availability = PROVIDER_LIBRARY[id].availability()
      expect(availability.available).toBe(false)
      expect(availability.reason).toContain("not wired")
    }
  })

  it("refuses to wrap a command through an unwired provider", () => {
    for (const id of ["vm"] as const) {
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

describe("lab policy resolver", () => {
  it("resolves a trusted workload to the worktree provider", () => {
    const decision = resolveProvider({ trust: "trusted" })
    expect(decision.id).toBe("worktree")
    expect(decision.reason).toContain("trusted workload")
  })

  it("keeps a suspicious workload on os-sandbox when the namespace tool works", () => {
    const library = fakeLibrary({ "os-sandbox": { available: true, reason: "unshare ready" } })
    expect(resolveProvider({ trust: "suspicious" }, library).id).toBe("os-sandbox")
  })

  it("falls back visibly to container when os-sandbox cannot run", () => {
    const library = fakeLibrary({
      "os-sandbox": { available: false, reason: "user namespaces are disabled" },
      container: { available: true, reason: "docker ready" },
    })
    const decision = resolveProvider({ trust: "suspicious" }, library)
    expect(decision.id).toBe("container")
    expect(decision.reason).toContain("falls back")
    expect(decision.reason).toContain("user namespaces are disabled")
  })

  it("refuses an untrusted workload when the container is down instead of downgrading", () => {
    const library = fakeLibrary({
      worktree: { available: true, reason: "always available" },
      container: { available: false, reason: "docker daemon down" },
    })
    expect(() => resolveProvider({ trust: "untrusted" }, library)).toThrow(/docker daemon down/)
    expect(() => resolveProvider({ trust: "untrusted" }, library)).toThrow(/not allowed/)
  })

  it("never resolves a non trusted workload to the worktree even when it is the only one up", () => {
    const library = fakeLibrary({
      "os-sandbox": { available: false, reason: "missing" },
      container: { available: false, reason: "missing" },
      vm: { available: false, reason: "missing" },
    })
    for (const trust of ["suspicious", "untrusted", "hostile"] as const) {
      expect(() => resolveProvider({ trust }, library)).toThrow(/cannot decide/)
    }
  })

  it("reserves the vm provider for hostile workloads and names it when it is missing", () => {
    const library = fakeLibrary({ vm: { available: true, reason: "vm runner ready" } })
    expect(resolveProvider({ trust: "hostile" }, library).id).toBe("vm")
    expect(() => resolveProvider({ trust: "hostile" })).toThrow(/reserved/)
  })

  it("refuses to honor a network allowlist through a kernel enforcing provider", () => {
    const library = fakeLibrary({ container: { available: true, reason: "docker ready" } })
    expect(() => resolveProvider({ trust: "trusted", provider: "container", network: "allowlist" }, library)).toThrow(/cannot honor a network allowlist/)
    expect(() => resolveProvider({ trust: "trusted", network: "allowlist" })).not.toThrow()
    expect(resolveProvider({ trust: "trusted", network: "allowlist" }).id).toBe("worktree")
  })

  it("refuses an auto allowlist for anything but a trusted workload", () => {
    const library = fakeLibrary({
      "os-sandbox": { available: true, reason: "unshare ready" },
      container: { available: true, reason: "docker ready" },
    })
    expect(() => resolveProvider({ trust: "suspicious", network: "allowlist" }, library)).toThrow(/cannot honor a network allowlist/)
  })
})

describe("lab network policy", () => {
  it("reads network and allowlist fields from the policy file", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, network: "allowlist", networkAllow: ["registry.example"] }, null, 2))
    const policy = await readLabPolicy(project as string)
    expect(policy.network).toBe("allowlist")
    expect(policy.networkAllow).toEqual(["registry.example"])
  })

  it("falls back to none when the policy file carries an invalid network value", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, network: "wide" }, null, 2))
    const policy = await readLabPolicy(project as string)
    expect(policy.network).toBe("none")
  })

  it("records the policy file network setting on a new sandbox", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, network: "allowlist", networkAllow: ["registry.example"] }, null, 2))
    const sandbox = await createSandbox({ projectRoot: project as string, adapter: "node", trust: "trusted" })
    expect(sandbox.policy.network).toBe("allowlist")
    expect(sandbox.policy.networkAllow).toEqual(["registry.example"])
    await destroySandbox(project as string, sandbox, true)
  })

  it("preserves network settings when the kill switch flips", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, network: "allowlist", networkAllow: ["registry.example"] }, null, 2))
    await setLabDisabled(project as string, true)
    const policy = await readLabPolicy(project as string)
    expect(policy.disabled).toBe(true)
    expect(policy.network).toBe("allowlist")
    expect(policy.networkAllow).toEqual(["registry.example"])
  })
})

describe("lab secrets policy", () => {
  it("reads secrets and allowlist fields from the policy file", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, secrets: "allowlist", secretsAllow: ["NPM_TOKEN"] }, null, 2))
    const policy = await readLabPolicy(project as string)
    expect(policy.secrets).toBe("allowlist")
    expect(policy.secretsAllow).toEqual(["NPM_TOKEN"])
  })

  it("falls back to none when the policy file carries an invalid secrets value", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, secrets: "all" }, null, 2))
    const policy = await readLabPolicy(project as string)
    expect(policy.secrets).toBe("none")
  })

  it("records the policy file secrets setting on a new sandbox", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, secrets: "allowlist", secretsAllow: ["NPM_TOKEN"] }, null, 2))
    const sandbox = await createSandbox({ projectRoot: project as string, adapter: "node", trust: "trusted" })
    expect(sandbox.policy.secrets).toBe("allowlist")
    expect(sandbox.policy.secretsAllow).toEqual(["NPM_TOKEN"])
    await destroySandbox(project as string, sandbox, true)
  })

  it("preserves secrets settings when the kill switch flips", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, secrets: "allowlist", secretsAllow: ["NPM_TOKEN"] }, null, 2))
    await setLabDisabled(project as string, true)
    const policy = await readLabPolicy(project as string)
    expect(policy.disabled).toBe(true)
    expect(policy.secrets).toBe("allowlist")
    expect(policy.secretsAllow).toEqual(["NPM_TOKEN"])
  })
})

describe("lab offline cache", () => {
  it("reads offline and registries fields from the policy file", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, offline: true, registries: ["registry.example"] }, null, 2))
    const policy = await readLabPolicy(project as string)
    expect(policy.offline).toBe(true)
    expect(policy.registries).toEqual(["registry.example"])
  })

  it("records the policy file offline setting on a new sandbox", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, offline: true, registries: ["registry.example"] }, null, 2))
    const sandbox = await createSandbox({ projectRoot: project as string, adapter: "node", trust: "trusted" })
    expect(sandbox.policy.offline).toBe(true)
    expect(sandbox.policy.registries).toEqual(["registry.example"])
    await destroySandbox(project as string, sandbox, true)
  })

  it("preserves offline settings when the kill switch flips", async () => {
    project = await makeAttackRepo()
    const dir = path.dirname(labPolicyFile(project as string))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(labPolicyFile(project as string), JSON.stringify({ disabled: false, offline: true, registries: ["registry.example"] }, null, 2))
    await setLabDisabled(project as string, true)
    const policy = await readLabPolicy(project as string)
    expect(policy.disabled).toBe(true)
    expect(policy.offline).toBe(true)
    expect(policy.registries).toEqual(["registry.example"])
  })
})

describe("lab os sandbox provider", () => {
  const osAvailable = PROVIDER_LIBRARY["os-sandbox"].availability().available

  it.runIf(osAvailable)("wraps a command in a Linux namespace with no network", () => {
    const wrapped = PROVIDER_LIBRARY["os-sandbox"].wrap("node", ["--version"], { cwd: "/tmp" })
    expect(wrapped).toEqual({
      command: "unshare",
      args: ["--user", "--map-root-user", "--net", "--pid", "--fork", "--kill-child", "--mount-proc", "node", "--version"],
    })
  })

  it.runIf(osAvailable)("blocks outbound TCP from inside the namespace", async () => {
    const wrapped = PROVIDER_LIBRARY["os-sandbox"].wrap(process.execPath, [
      "-e",
      "const net=require('node:net'); const s=net.connect({host:'1.1.1.1',port:80}); s.on('error',(e)=>{console.log('NETERR',e.code);process.exit(0)}); s.on('connect',()=>{console.log('CONNECTED');process.exit(1)}); setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},3000)",
    ], { cwd: process.cwd() })
    const result = await runLabProcess(wrapped.command, wrapped.args, { cwd: process.cwd(), timeoutMs: 10000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("NETERR ENETUNREACH")
  })

  it.runIf(!osAvailable)("reports why the namespace provider cannot run on this host", () => {
    const availability = PROVIDER_LIBRARY["os-sandbox"].availability()
    expect(availability.available).toBe(false)
    expect(availability.reason.length).toBeGreaterThan(0)
  })
})

describe("lab container provider", () => {
  const containerAvailable = PROVIDER_LIBRARY.container.availability().available

  it.runIf(containerAvailable)("wraps a command in a docker run with no network", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined
    const userArgs = typeof uid === "number" && typeof gid === "number" ? ["--user", `${uid}:${gid}`] : []
    const wrapped = PROVIDER_LIBRARY.container.wrap("node", ["--version"], { cwd: "/tmp", containerImage: "node:22" })
    expect(wrapped).toEqual({
      command: "docker",
      args: ["run", "--rm", "--network", "none", "-e", "HOME=/tmp", "-e", "CI=opencode-lab", "-e", "OPENCODE_LAB=1", "-v", "/tmp:/workspace", "-w", "/workspace", ...userArgs, "node:22", "node", "--version"],
    })
  })

  it.runIf(!containerAvailable)("reports why the container provider cannot run on this host", () => {
    const availability = PROVIDER_LIBRARY.container.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason.length).toBeGreaterThan(0)
  })
})

describe("lab vm provider", () => {
  it("stays reserved and explains why it cannot run", () => {
    const availability = PROVIDER_LIBRARY.vm.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain("reserved")
    expect(() => PROVIDER_LIBRARY.vm.wrap("node", [], { cwd: "/tmp" })).toThrow(/reserved/)
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

  it("hands the workload trust to the policy resolver instead of assuming worktree", async () => {
    project = await makeAttackRepo()
    await expect(
      createSandbox({ projectRoot: project as string, adapter: "node", trust: "hostile" }),
    ).rejects.toThrow(/hostile workload/)
  })

  it("refuses to create a sandbox through the reserved vm provider", async () => {
    project = await makeAttackRepo()
    await expect(
      createSandbox({ projectRoot: project as string, adapter: "node", provider: "vm" }),
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
