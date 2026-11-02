import { spawnSync } from "node:child_process"
import type { ProviderAvailability, SandboxNetworkPolicy, SandboxProvider, SandboxProviderId, SandboxTrust } from "./types"
import { WORKTREE_PROVIDER } from "./types"

function notWired(id: SandboxProviderId): () => ProviderAvailability {
  return () => ({ available: false, reason: `The ${id} provider is not wired in this phase` })
}

function osSandboxAvailability(): ProviderAvailability {
  if (process.platform !== "linux") {
    return { available: false, reason: `The os-sandbox provider needs Linux namespaces and ${process.platform} does not expose them` }
  }
  const probe = spawnSync("unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--kill-child", "--mount-proc", "true"], {
    stdio: "ignore",
    timeout: 5000,
  })
  if (probe.error) {
    return { available: false, reason: `The os-sandbox provider could not run unshare: ${probe.error.message}` }
  }
  if (probe.status !== 0) {
    return { available: false, reason: `The os-sandbox provider probe exited with status ${probe.status ?? "unknown"}, so user namespaces are probably disabled` }
  }
  return { available: true, reason: "Linux user, network, pid and mount namespaces are available" }
}

function refuseWrap(id: SandboxProviderId): SandboxProvider["wrap"] {
  return () => {
    throw new Error(`The ${id} provider refuses to wrap a command because it is not wired in this phase`)
  }
}

// Describes every provider id the lab recognizes, including the ones a later phase still has to wire.
export const PROVIDER_LIBRARY: Record<SandboxProviderId, SandboxProvider> = {
  worktree: WORKTREE_PROVIDER,
  "os-sandbox": {
    id: "os-sandbox",
    description: "An OS enforced sandbox using Linux user, network, pid and mount namespaces",
    availability: () => osSandboxAvailability(),
    wrap: (command, args) => ({
      command: "unshare",
      args: ["--user", "--map-root-user", "--net", "--pid", "--fork", "--kill-child", "--mount-proc", command, ...args],
    }),
  },
  container: {
    id: "container",
    description: "A disposable container run",
    availability: notWired("container"),
    wrap: refuseWrap("container"),
  },
  vm: {
    id: "vm",
    description: "A disposable virtual machine reserved for hostile workloads",
    availability: notWired("vm"),
    wrap: refuseWrap("vm"),
  },
}

// The worktree provider stays the default because it needs nothing beyond git and is available in CI.
export const DEFAULT_PROVIDER_ID: SandboxProviderId = "worktree"

export function isSandboxProviderId(value: unknown): value is SandboxProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_LIBRARY, value)
}

// auto is a selection policy rather than a provider id, so the type keeps it apart from the library keys.
export type ProviderSelection = "auto" | SandboxProviderId

export interface ProviderDecision {
  id: SandboxProviderId
  reason: string
}

interface ResolveProviderRequest {
  trust: SandboxTrust
  provider?: ProviderSelection
  network?: SandboxNetworkPolicy
}

// Maps workload trust onto a provider chain, picks the first available entry and refuses to settle for a weaker level.
export function resolveProvider(
  request: ResolveProviderRequest,
  library: Record<SandboxProviderId, SandboxProvider> = PROVIDER_LIBRARY,
): ProviderDecision {
  const selection = request.provider ?? "auto"
  if (selection !== "auto") {
    if (request.network === "allowlist" && selection !== "worktree") {
      throw new Error(
        `The ${selection} provider cannot honor a network allowlist because it blocks all egress at the kernel level`,
      )
    }
    const availability = library[selection].availability()
    if (!availability.available) {
      throw new Error(`The ${selection} provider was requested explicitly but is unavailable: ${availability.reason}`)
    }
    return { id: selection, reason: `an explicit request selects the ${selection} provider` }
  }
  if (request.network === "allowlist" && request.trust !== "trusted") {
    throw new Error(
      `The auto policy cannot honor a network allowlist for a ${request.trust} workload because every provider on its chain blocks all egress, use network none or a trusted workload`,
    )
  }
  const chain: readonly SandboxProviderId[] =
    request.trust === "trusted"
      ? ["worktree"]
      : request.trust === "suspicious"
        ? ["os-sandbox", "container"]
        : request.trust === "untrusted"
          ? ["container"]
          : ["vm"]
  const failures: string[] = []
  for (const id of chain) {
    const availability = library[id].availability()
    if (availability.available) {
      return {
        id,
        reason:
          failures.length === 0
            ? `auto resolves a ${request.trust} workload to the ${id} provider`
            : `auto falls back to the ${id} provider after ${failures.join(" and ")}`,
      }
    }
    failures.push(`${id} is unavailable (${availability.reason})`)
  }
  if (request.trust === "hostile") {
    throw new Error(
      `The auto policy cannot decide for a hostile workload because ${failures.join(" and ")} and the vm provider stays reserved until a later phase wires it`,
    )
  }
  throw new Error(
    `The auto policy cannot decide for a ${request.trust} workload because ${failures.join(" and ")} and downgrading to a weaker provider is not allowed`,
  )
}

export function describeProvider(id: SandboxProviderId): string {
  return PROVIDER_LIBRARY[id].description
}
