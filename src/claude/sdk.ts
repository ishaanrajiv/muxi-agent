/**
 * The Claude Agent SDK, loaded on first use, and the settings every Claude
 * session shares: the isolation layer and the sandbox switch for sessions
 * that never run a command.
 */

import type { Options, Query, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeExecutable } from "../claude-binary.ts";

// The SDK is a large module (about 60 ms to load) that only a Claude turn,
// probe or session read needs, so it loads on first use instead of at boot.
let sdk: Promise<typeof import("@anthropic-ai/claude-agent-sdk")> | undefined;
export const loadSdk = () => (sdk ??= import("@anthropic-ai/claude-agent-sdk"));

/**
 * Bootstrap/utility sessions run zero commands, but the CLI still initializes
 * its Bash sandbox at session start, and on macOS that init sweeps every
 * TCC-protected folder (Documents/Downloads/Media Library) — the prompts get
 * attributed to the host app (anthropics/claude-code#61233). Sandbox off for
 * every session that never executes a command; real turns are unaffected.
 */
export const SANDBOX_OFF = { enabled: false } as const;
/** Isolation: the flag-settings layer every session gets (see the
 *  `claude-provider.ts` header). */
export const ISOLATED_SETTINGS = { autoMemoryEnabled: false };
/** The CLI's environment variable for the auto-compact window. It outranks the
 *  `autoCompactWindow` setting, so a session given the setting runs without it. */
export const AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
/** The auto-compact windows the CLI accepts, in tokens. */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * A provider's `autoCompactWindow`, checked: a whole number of tokens the CLI
 * accepts. Outside its range the CLI would clamp it quietly, so it fails here.
 */
export function checkAutoCompactWindow(tokens: number | undefined): number | undefined {
  if (tokens === undefined) return undefined;
  if (!Number.isInteger(tokens) || tokens < AUTO_COMPACT_WINDOW_MIN || tokens > AUTO_COMPACT_WINDOW_MAX) {
    throw new RangeError(
      `autoCompactWindow must be a whole number of tokens from ${AUTO_COMPACT_WINDOW_MIN} to ${AUTO_COMPACT_WINDOW_MAX}, got ${tokens}`,
    );
  }
  return tokens;
}

/**
 * A chat turn's options with its auto-compact window: the setting joins the
 * isolated flag settings, and the CLI's env loses {@link AUTO_COMPACT_WINDOW_ENV},
 * which would otherwise win over it (a host started from a shell that sets it).
 * Without a window, the options are unchanged and the CLI keeps its own default.
 */
export function withAutoCompactWindow(options: Options, tokens: number | undefined): Options {
  if (tokens === undefined) return options;
  const { [AUTO_COMPACT_WINDOW_ENV]: _dropped, ...env } = options.env ?? process.env;
  return { ...options, settings: { ...ISOLATED_SETTINGS, autoCompactWindow: tokens }, env };
}
/** Same switch for the `claude -p` shell-outs (probe/getUsage). */
export const SANDBOX_OFF_SETTINGS_ARGS = ["--settings", '{"sandbox":{"enabled":false}}'] as const;

/**
 * The executable to hand the SDK, or undefined to let it resolve its own
 * bundled native CLI (the normal case, and the one this code must not
 * second-guess: the SDK's resolver knows its platform variants). A PATH copy
 * IS passed explicitly — the SDK never looks there on its own, so without this
 * a machine with `claude` installed but no platform package could not run a
 * turn at all.
 */
export function sdkExecutablePath(configuredPath: string | undefined): string | undefined {
  const exe = resolveClaudeExecutable(configuredPath);
  return !exe || exe.source === "bundled" ? undefined : exe.path;
}

/** The option naming the executable to run, or none to let the SDK resolve
 *  its own bundled CLI. */
export function executableOption(path: string | undefined): Pick<Options, "pathToClaudeCodeExecutable"> {
  return path ? { pathToClaudeCodeExecutable: path } : {};
}

/**
 * Run one control request against a CLI session that never takes a turn: the
 * prompt is a streaming input that never yields, so the CLI starts, serves the
 * request, and is aborted before any turn (or token) happens.
 */
export async function withIdleSession<T>(
  queryFn: typeof query | undefined,
  executablePath: string | undefined,
  read: (q: Query) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const controller = new AbortController();
  const idle = async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<never>(() => {});
  };
  const q = (queryFn ?? (await loadSdk()).query)({
    prompt: idle(),
    options: {
      abortController: controller,
      settingSources: [],
      settings: ISOLATED_SETTINGS,
      strictMcpConfig: true,
      skills: [],
      tools: [],
      mcpServers: {},
      sandbox: SANDBOX_OFF,
      ...executableOption(executablePath),
    },
  });
  try {
    return timeoutMs === undefined
      ? await read(q)
      : await Promise.race([
          read(q),
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error(`Claude session read timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            t.unref?.();
          }),
        ]);
  } finally {
    controller.abort();
    // Drain the (now-aborting) message stream so its teardown can't surface
    // as an unhandled rejection.
    void (async () => {
      try {
        for await (const _ of q) void _;
      } catch {
        /* aborted */
      }
    })();
  }
}
