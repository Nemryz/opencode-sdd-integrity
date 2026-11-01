import { describe, it, expect, afterEach } from "vitest"
import { runLabProcess } from "../../lab/core/runner"
import { deniedEnvironmentKeys, LAB_ENV_DENY, safeLabEnvironment } from "../../lab/core/environment"
import { denylistedEnvironmentKeys, isDenylistedEnvironmentKey } from "../../lab/core/security"
const SECRET_NAME = "CORPUS_LEAK_COOKIE"
const SECRET_VALUE = "corpus-secret-cookie-9f2a"

const injectedEnv: Array<[string, string]> = []
const envSnapshot = process.env

afterEach(() => {
  for (const [name] of injectedEnv) {
    delete process.env[name]
  }
  injectedEnv.length = 0
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
})

describe("corpus environment leak", () => {
  it("does not hand project secrets to a sandbox child while the safe contract survives", async () => {
    process.env[SECRET_NAME] = SECRET_VALUE
    injectedEnv.push([SECRET_NAME, SECRET_VALUE])

    const printer = "console.log(JSON.stringify({lab: process.env.OPENCODE_LAB, net: process.env.OPENCODE_LAB_NETWORK, secret: process.env.CORPUS_LEAK_COOKIE ?? null}))"
    const result = await runLabProcess(process.execPath, ["-e", printer], { cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.code).toBe(0)
    const printed = JSON.parse(result.stdout.trim()) as { lab: string, net: string, secret: string | null }
    expect(printed.lab).toBe("1")
    expect(printed.net).toBe("none")
    expect(printed.secret).toBeNull()

    const guard = safeLabEnvironment(process.env, ["PATH", "HOME"], {})
    expect(guard[SECRET_NAME]).toBeUndefined()
  })

  it("flags the deny listed names that a workspace may still carry into its own process", () => {
    const hostile: NodeJS.ProcessEnv = {}
    for (const name of [...LAB_ENV_DENY, "MY_ACCESS_TOKEN", "GCP_SECRET_KEY_STORE"]) {
      hostile[name] = "hostile-value"
    }
    const flagged = new Set(deniedEnvironmentKeys(hostile))
    for (const name of LAB_ENV_DENY) {
      expect(flagged.has(name)).toBe(true)
    }
    expect(flagged.has("MY_ACCESS_TOKEN")).toBe(true)
  })

  it("matches the trailing secret shapes used by real credential variables", () => {
    expect(isDenylistedEnvironmentKey("GITHUB_TOKEN")).toBe(true)
    expect(isDenylistedEnvironmentKey("AWS_SECRET_ACCESS_KEY")).toBe(true)
    expect(isDenylistedEnvironmentKey("MY-DB-PASSWORD")).toBe(true)
    expect(isDenylistedEnvironmentKey("SESSION")).toBe(false)
  })
})

describe("corpus command injection", () => {
  it("passes argv literally so shell metacharacters inside record values stay inert", async () => {
    const payload = "ok; rm -rf /|`echo pwned`&&echo pwned2"
    const argv = ["-e", `console.log(JSON.stringify(process.argv.slice(1)))`, payload]
    const result = await runLabProcess(process.execPath, argv, { cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.code).toBe(0)
    const echo = JSON.parse(result.stdout.trim()) as string[]
    expect(echo).toEqual([payload])
  })

  it("keeps newline and quote payloads inside one argv slot without spawning a shell", async () => {
    const payload = "a\nb'c\"d$HOME*k"
    const result = await runLabProcess(process.execPath, ["-e", "console.log(process.argv[1])", payload], { cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.stdout).toBe(`${payload}\n`)
    expect(result.stdout).not.toContain(`${process.env.HOME}`)
  })
})
