/**
 * Codex environment probe — detect binary, version, login status,
 * and confirm app-server capability.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { errorMessage } from "./shared.ts";

const exec = promisify(execFile);

export interface ProbeResult {
  /** Whether the codex binary was found. */
  found: boolean;
  /** Resolved path to the codex binary. */
  path: string | null;
  /** Codex CLI version string (e.g. "codex-cli 0.135.0"). */
  version: string | null;
  /** Whether the user is logged in. Read together with {@link loginProbeFailed}:
   *  `false` with that flag set means "couldn't tell", not "logged out". */
  loggedIn: boolean;
  /** True when the login check itself failed to produce any output, so
   *  {@link loggedIn} carries no information (see `errors` for the cause). */
  loginProbeFailed?: boolean;
  /** Whether app-server subcommand is available. */
  appServerAvailable: boolean;
  /** List of registered MCP servers. */
  mcpServers: string[];
  /** Any errors encountered during probe. */
  errors: string[];
}

export interface ProbeOptions {
  /**
   * Skip the `codex doctor` round trip. Doctor is here only to answer the login
   * question, and it is the slowest call in this file (15s budget); a caller who
   * already read the account over the app-server has a better answer and should
   * not pay for a second, weaker one. {@link ProbeResult.loginProbeFailed} is set
   * so nothing mistakes the skipped check for a signed-out verdict.
   */
  skipLoginCheck?: boolean;
}

/**
 * Probe the local Codex installation.
 *
 * @param codexBin - Path to codex binary (default: "codex")
 * @param env - Extra env for the `codex`/`which` calls (e.g. `CODEX_HOME` so the
 *   MCP-list + auth checks read the dedicated home, not the developer's `~/.codex`).
 */
export async function probe(
  codexBin = "codex",
  env?: Record<string, string>,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  // `which` doesn't care about CODEX_HOME, but the codex subcommands do — apply
  // the overlay to every codex call so login/MCP state reflects the right home.
  const opts = env ? { env: { ...process.env, ...env } } : {};
  const result: ProbeResult = {
    found: false,
    path: null,
    version: null,
    loggedIn: false,
    appServerAvailable: false,
    mcpServers: [],
    errors: [],
  };

  // 1. Find binary
  try {
    const { stdout } = await exec("which", [codexBin]);
    result.path = stdout.trim();
    result.found = true;
  } catch {
    result.errors.push(`codex binary not found: ${codexBin}`);
    return result;
  }

  // 2. Version
  try {
    const { stdout } = await exec(codexBin, ["--version"], opts);
    result.version = stdout.trim();
  } catch (e) {
    result.errors.push(`Failed to get version: ${errorMessage(e)}`);
  }

  // 3. Login status (check via doctor output)
  if (options.skipLoginCheck) {
    result.loginProbeFailed = true;
  } else {
    try {
      const { stdout } = await exec(codexBin, ["doctor"], { ...opts, timeout: 15_000 });
      result.loggedIn = doctorShowsAuth(stdout);
    } catch (e) {
      const stdout = errorStdout(e);
      if (stdout) {
        // `codex doctor` exits non-zero when any check fails; its auth line is
        // still authoritative when we got output.
        result.loggedIn = doctorShowsAuth(stdout);
        result.errors.push(`Doctor check failed: ${errorMessage(e)}`);
      } else {
        // No output at all (timeout, killed, exec failure): we learned NOTHING
        // about the login. Say so explicitly — `loggedIn: false` here means
        // "unknown", not "logged out", and callers must not tell a signed-in
        // user to sign in on the strength of it.
        result.loginProbeFailed = true;
        result.errors.push(`Login check inconclusive: ${errorMessage(e)}`);
      }
    }
  }

  // 4. App-server availability
  try {
    const { stdout } = await exec(codexBin, ["app-server", "--help"], opts);
    result.appServerAvailable = stdout.includes("app server");
  } catch (e) {
    result.errors.push(`app-server subcommand not available: ${errorMessage(e)}`);
  }

  // 5. MCP servers
  try {
    const { stdout } = await exec(codexBin, ["mcp", "list"], opts);
    const lines = stdout.trim().split("\n").filter((l) => l.trim());
    // Skip header line
    result.mcpServers = lines
      .slice(1)
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean);
  } catch (e) {
    result.errors.push(`MCP list failed: ${errorMessage(e)}`);
  }

  return result;
}

/**
 * True when `codex doctor` reports a configured login.
 *
 * The wording has already changed once ("✓ auth" → "auth  auth is configured"),
 * and a third reword must not silently flip every user to logged-out — so match
 * any auth line carrying a positive marker and no negation, rather than one
 * exact phrase.
 */
export function doctorShowsAuth(stdout: string): boolean {
  return stdout
    .split("\n")
    .filter((line) => /\bauth\b/i.test(line))
    .some(
      (line) =>
        /✓|\bconfigured\b|\blogged in\b|\bsigned in\b|\bauthenticated\b|\bok\b/i.test(line) &&
        !/✗|✖|\bnot\b|\bno\b|\bmissing\b|\bnone\b|\bfailed\b|\bexpired\b/i.test(line),
    );
}

function errorStdout(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    return (error as { stdout: string }).stdout;
  }
  return "";
}
