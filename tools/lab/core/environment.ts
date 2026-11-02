import { isDenylistedEnvironmentKey } from "./security"

// The parent keys a child may inherit, so project secrets never flow into a sandbox command.
export const SAFE_HINTS: string[] = [
  "PATH",
  "HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "PROGRAMFILES",
  "SHELL",
  "LANG",
  "NODE_OPTIONS",
  "NODE_PATH",
  "FORCE_COLOR",
  "NO_COLOR",
]

// Marks the environment as a lab child and disables lifecycle scripts plus program downloads before installs.
export const DEFAULT_LAB_ENV: Readonly<Record<string, string>> = {
  CI: "opencode-lab",
  OPENCODE_LAB: "1",
  OPENCODE_LAB_NETWORK: "none",
  HUSKY: "0",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
  npm_config_ignore_scripts: "true",
  NPM_CONFIG_AUDIT: "false",
  npm_config_audit: "false",
  NPM_CONFIG_FUND: "false",
  npm_config_fund: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  YARN_ENABLE_SCRIPTS: "false",
  PUPPETEER_SKIP_DOWNLOAD: "true",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  CYPRESS_INSTALL_BINARY: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  BROWSER: "none",
}

// Parent keys the lab refuses even inside the allowlist, covering agents, proxies and cloud credentials.
export const LAB_ENV_DENY: string[] = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GNUPGHOME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "NETRC_FILE",
  "SSH_CONFIG",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "PGPASSWORD",
  "DATABASE_URL",
]

export interface LabEnvironmentOptions {
  allowList?: string[]
  defaults?: NodeJS.ProcessEnv
}

// Composes the child environment from passed values and safe defaults, never from a blanket parent copy.
export function safeLabEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  allowList: string[] = [],
  defaults: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  // The allowlist alone cannot be trusted, so a denied key is dropped even when a caller names it.
  for (const key of allowList) {
    if (key in parentEnvironment && !isDeniedEnvironmentKey(key)) sanitized[key] = parentEnvironment[key] ?? ""
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value !== "undefined") sanitized[key] = value
  }
  return sanitized
}

// One verdict for a parent key so the sanitizer and the audit view can never disagree.
export function isDeniedEnvironmentKey(key: string): boolean {
  return LAB_ENV_DENY.some((entry) => entry.toUpperCase() === key.toUpperCase()) || isDenylistedEnvironmentKey(key)
}

export function deniedEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => isDeniedEnvironmentKey(key))
}
