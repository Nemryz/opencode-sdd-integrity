import type { SandboxProvider, SandboxProviderId } from "./types"
import { WORKTREE_PROVIDER } from "./types"

// Describes every provider id the lab recognizes, including the ones a later phase still has to wire.
export const PROVIDER_LIBRARY: Record<SandboxProviderId, SandboxProvider> = {
  worktree: WORKTREE_PROVIDER,
  "os-sandbox": {
    id: "os-sandbox",
    description: "An OS enforced sandbox such as seatbelt or apparmor, not wired in this phase",
  },
  container: {
    id: "container",
    description: "A disposable container run, not wired in this phase",
  },
  vm: {
    id: "vm",
    description: "A disposable virtual machine, not wired in this phase",
  },
}

// The worktree provider stays the default because it needs nothing beyond git and is available in CI.
export const DEFAULT_PROVIDER_ID: SandboxProviderId = "worktree"

export function describeProvider(id: SandboxProviderId): string {
  return PROVIDER_LIBRARY[id].description
}
