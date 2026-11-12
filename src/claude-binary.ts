/**
 * Which `claude` binary actually runs a turn.
 *
 * The Claude Agent SDK ships its own native CLI as an optional platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`) and spawns THAT
 * whenever `pathToClaudeCodeExecutable` is unset — the usual case,
 * since bundlers copy the SDK and its platform sibling together. Detection that judged PATH `claude` instead was answering a
 * different question from the one the turn path asks, so a packaged app with an
 * empty PATH refused turns it would have run.
 *
 * This module resolves the same binary the SDK would, by the same rule, so the
 * probe reports the executing binary's version and the pre-flight never refuses
 * a Claude turn that has a runnable CLI.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";

import type { AgentBinarySource } from "./types/index.ts";

/** A resolved Claude CLI: the absolute path and where it came from. */
export interface ClaudeExecutable {
  path: string;
  source: AgentBinarySource;
}

/** The SDK's own naming rule for its native CLI package (see its resolver). */
function nativeCliSpecifier(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const suffix = platform === "win32" ? ".exe" : "";
  const pkg =
    platform === "android"
      ? `@anthropic-ai/claude-agent-sdk-linux-${arch}-android`
      : `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  return `${pkg}/claude${suffix}`;
}

let bundledCache: { path: string | null } | null = null;

/**
 * The native CLI bundled with the installed Agent SDK, or null when the
 * platform package is absent (a `--omit=optional` install). Resolved RELATIVE TO
 * THE SDK, not to this package: pnpm links the platform package next to the SDK
 * in its own store dir, where a lookup from here can't reach it. Memoized — the
 * answer can't change without a restart.
 */
export function bundledClaudeExecutable(): string | null {
  if (bundledCache) return bundledCache.path;
  let path: string | null = null;
  try {
    const here = createRequire(import.meta.url);
    const fromSdk = createRequire(here.resolve("@anthropic-ai/claude-agent-sdk"));
    const candidate = fromSdk.resolve(nativeCliSpecifier());
    if (existsSync(candidate)) path = candidate;
  } catch {
    // No SDK, or no platform package for this platform/arch — fall back to PATH.
  }
  bundledCache = { path };
  return path;
}

/** An executable `claude` on PATH, resolved without spawning `which` (this runs
 *  on the turn pre-flight path, which must never block on a process). */
export function claudeOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — keep walking.
    }
  }
  return null;
}

/**
 * The binary a Claude turn will run, in the SDK's own precedence: an explicit
 * override first, then the bundled native CLI, then a PATH `claude`. The SDK
 * only ever spawns the first two on its own; a PATH copy is usable because the
 * provider passes it back to the SDK as an explicit executable path, which is
 * the difference between "the platform package is missing" and "Claude doesn't
 * work here".
 *
 * Returns null when nothing resolves at all — the only state that may render as
 * "not installed".
 */
export function resolveClaudeExecutable(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeExecutable | null {
  if (configured) return { path: configured, source: "configured" };
  const bundled = bundledClaudeExecutable();
  if (bundled) return { path: bundled, source: "bundled" };
  const onPath = claudeOnPath(env);
  if (onPath) return { path: onPath, source: "path" };
  return null;
}

/** Test seam: drop the memoized bundled-CLI lookup. */
export function resetClaudeExecutableCache(): void {
  bundledCache = null;
}
