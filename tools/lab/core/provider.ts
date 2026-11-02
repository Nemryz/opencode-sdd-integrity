import type { ProviderAvailability, SandboxProvider, SandboxProviderId } from "./types"
import { WORKTREE_PROVIDER } from "./types"

function notWired(id: SandboxProviderId): () => ProviderAvailability {
  return () => ({ available: false, reason: `The ${id} provider is not wired in this phase` })
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
    description: "An OS enforced sandbox such as namespaces or seatbelt",
    availability: notWired("os-sandbox"),
    wrap: refuseWrap("os-sandbox"),
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

export function describeProvider(id: SandboxProviderId): string {
  return PROVIDER_LIBRARY[id].description
}
