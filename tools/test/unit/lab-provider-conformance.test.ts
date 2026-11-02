import { describe, it, expect } from "vitest"
import { PROVIDER_LIBRARY, describeProvider, resolveProvider } from "../../lab/core/provider"
import { ISOLATION_TRUST } from "../../lab/core/security"
import type { SandboxProviderId } from "../../lab/core/types"
import { isSandboxProviderId } from "../../lab/core/provider"

const PROVIDER_IDS: SandboxProviderId[] = ["worktree", "os-sandbox", "container", "vm"]

describe("lab provider conformance", () => {
  for (const id of PROVIDER_IDS) {
    describe(id, () => {
      it("is registered with a complete contract", () => {
        const provider = PROVIDER_LIBRARY[id]
        expect(provider.id).toBe(id)
        expect(typeof provider.description).toBe("string")
        expect(provider.description.length).toBeGreaterThan(0)
        expect(typeof provider.availability).toBe("function")
        expect(typeof provider.wrap).toBe("function")
        expect(describeProvider(id).length).toBeGreaterThan(0)
        expect(isSandboxProviderId(id)).toBe(true)
      })

      it("reports availability as a structured verdict", () => {
        const availability = PROVIDER_LIBRARY[id].availability()
        expect(typeof availability.available).toBe("boolean")
        expect(typeof availability.reason).toBe("string")
        expect(availability.reason.length).toBeGreaterThan(0)
      })

      it("keeps its isolation trust consistent with the threat model", () => {
        expect(ISOLATION_TRUST[id]).toBeDefined()
        if (id === "worktree") {
          expect(ISOLATION_TRUST[id]).toBe("process-level")
        } else {
          expect(ISOLATION_TRUST[id]).toBe("kernel-enforced")
        }
      })

      it("either transforms a command or refuses it loudly, never silently", () => {
        const provider = PROVIDER_LIBRARY[id]
        try {
          const wrapped = provider.wrap("node", ["--version"], { cwd: "/tmp" })
          expect(typeof wrapped.command).toBe("string")
          expect(wrapped.command.length).toBeGreaterThan(0)
          expect(Array.isArray(wrapped.args)).toBe(true)
          expect(wrapped.args.length).toBeGreaterThan(0)
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message.length).toBeGreaterThan(0)
        }
      })
    })
  }

  it("never resolves a non trusted workload to the worktree provider", () => {
    const library = { ...PROVIDER_LIBRARY }
    for (const id of ["os-sandbox", "container", "vm"] as const) {
      library[id] = { ...library[id], availability: () => ({ available: false, reason: "forced off" }) }
    }
    for (const trust of ["suspicious", "untrusted", "hostile"] as const) {
      expect(() => resolveProvider({ trust }, library)).toThrow()
    }
  })

  it("never downgrades a kernel-enforcing workload to process level", () => {
    const library = {
      ...PROVIDER_LIBRARY,
      "os-sandbox": { ...PROVIDER_LIBRARY["os-sandbox"], availability: () => ({ available: true, reason: "ready" }) },
    }
    const decision = resolveProvider({ trust: "suspicious" }, library)
    expect(decision.id).not.toBe("worktree")
    expect(ISOLATION_TRUST[decision.id]).toBe("kernel-enforced")
  })

  it("keeps the auto fallback visible instead of silent", () => {
    const library = {
      ...PROVIDER_LIBRARY,
      "os-sandbox": { ...PROVIDER_LIBRARY["os-sandbox"], availability: () => ({ available: false, reason: "no namespaces" }) },
      container: { ...PROVIDER_LIBRARY.container, availability: () => ({ available: true, reason: "docker ready" }) },
    }
    const decision = resolveProvider({ trust: "suspicious" }, library)
    expect(decision.id).toBe("container")
    expect(decision.reason).toContain("falls back")
  })

  it("refuses an explicit unavailable provider with the reason", () => {
    expect(() => resolveProvider({ trust: "trusted", provider: "vm" })).toThrow(/reserved/)
  })
})
