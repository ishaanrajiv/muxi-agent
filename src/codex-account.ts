/**
 * The Codex account lifecycle, spoken over the app-server protocol rather than
 * scraped from a CLI's stdout.
 *
 * `codex login` is a terminal program that runs its own loopback OAuth server
 * and prints a URL. Driving it from a GUI means spawning it, regex-hunting the
 * URL out of ANSI-coloured output, and inferring success from an exit code. The
 * app-server exposes the same flow as typed methods — `account/read`,
 * `account/login/start`, `account/login/cancel`, `account/logout`, and the
 * `account/login/completed` notification — so the URL arrives as a field and the
 * outcome as an event.
 *
 * Every method here is optional at runtime: a codex old enough to lack one
 * rejects the request, {@link CodexAccountUnsupportedError} says so, and the
 * caller falls back to spawning the subcommand. Nothing in this module decides
 * WHICH `CODEX_HOME` it acts on — the caller passes the env it wants, because
 * reading auth and writing it deliberately target different homes (see the
 * server's `cli-setup`).
 */

import type { AgentProviderAuth } from "./types/index.ts";

import { CodexClient } from "./codex-client.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { Account } from "./generated/v2/Account.ts";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.ts";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse.ts";
import { errorMessage, toError } from "./shared.ts";

/** How long any single account round trip may take, spawn included. The reads
 *  are local (`account/read` returns cached credentials) — a budget this size is
 *  for a cold app-server spawn, not for the call. */
const ACCOUNT_TIMEOUT_MS = 20_000;

export interface CodexAccountOptions {
  /** The codex binary to spawn — the same one the provider runs turns with. */
  codexBin?: string;
  /** Working directory for the app-server process. */
  cwd?: string;
  /** Env overlay, notably `CODEX_HOME`. Absent means the user's own home. */
  env?: Record<string, string>;
}

/**
 * The installed codex has no such app-server method. Distinct from a transport
 * failure so callers can fall back to the CLI subcommand instead of reporting
 * an error the user can't act on.
 */
export class CodexAccountUnsupportedError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`This Codex build has no \`${method}\` app-server method.`);
    this.method = method;
    this.name = "CodexAccountUnsupportedError";
  }
}

/**
 * Codex rejects an unimplemented method as a serde deserialization failure
 * ("Invalid request: unknown variant `account/logout`, expected one of …") under
 * JSON-RPC's -32600, not as -32601. Match both, so a future build that switches
 * to the standard code still falls back rather than surfacing a raw RPC error.
 */
export function isUnknownMethod(err: unknown): boolean {
  return /unknown variant|method not found|-32601/i.test(errorMessage(err));
}

function rethrowAsUnsupported(method: string, err: unknown): never {
  if (isUnknownMethod(err)) throw new CodexAccountUnsupportedError(method);
  throw toError(err);
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Spawn an app-server and complete the handshake. The caller owns `stop()`. */
async function openSession(opts: CodexAccountOptions): Promise<CodexClient> {
  const client = new CodexClient({
    ...(opts.codexBin ? { codexBin: opts.codexBin } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  await client.start();
  await client.initialize();
  return client;
}

// ── Reading the account ──────────────────────────────────────────────────────

/**
 * The login behind the given Codex home, as the app-server sees it — the same
 * credentials a turn would use, with the account's plan and email.
 *
 * `null` means the protocol couldn't answer (no binary, no `app-server`, no
 * `account/read`, a timeout) and the caller should fall back to its own check.
 * It never means "signed out": that is a definitive
 * `{ status: "unauthenticated" }`.
 */
export async function readCodexAccount(
  opts: CodexAccountOptions = {},
): Promise<AgentProviderAuth | null> {
  let client: CodexClient | undefined;
  try {
    client = await withTimeout(openSession(opts), ACCOUNT_TIMEOUT_MS, "codex app-server start");
    const res = (await withTimeout(
      client.request("account/read", {}),
      ACCOUNT_TIMEOUT_MS,
      "account/read",
    )) as GetAccountResponse;
    return authFromAccount(res);
  } catch {
    return null;
  } finally {
    await client?.stop().catch(() => {});
  }
}

/**
 * Map an `account/read` answer onto the contract's three-state auth.
 *
 * No account with `requiresOpenaiAuth` is the one shape that definitively means
 * signed out. No account WITHOUT it means codex is pointed at a model provider
 * that needs no OpenAI login at all — reporting that as unverified would leave a
 * permanent warning on a working install.
 */
export function authFromAccount(res: GetAccountResponse): AgentProviderAuth {
  const account = res.account;
  if (!account) {
    return res.requiresOpenaiAuth
      ? { status: "unauthenticated" }
      : { status: "authenticated", method: "none", label: "No sign-in required" };
  }
  switch (account.type) {
    case "apiKey":
      return { status: "authenticated", method: "apiKey", label: "OpenAI API key" };
    case "amazonBedrock":
      return { status: "authenticated", method: "amazonBedrock", label: "Amazon Bedrock" };
    default: {
      const chatgpt = account as Extract<Account, { type: "chatgpt" }>;
      const email = typeof chatgpt.email === "string" ? chatgpt.email : "";
      return {
        status: "authenticated",
        method: "chatgpt",
        label: chatgptPlanLabel(chatgpt.planType),
        ...(email ? { email } : {}),
      };
    }
  }
}

/** Display copy for a ChatGPT plan. Codex adds plan types faster than the
 *  generated union tracks them, so an unrecognized one still reads sensibly. */
function chatgptPlanLabel(planType: string): string {
  switch (planType) {
    case "free":
      return "ChatGPT Free";
    case "go":
      return "ChatGPT Go";
    case "plus":
      return "ChatGPT Plus";
    case "pro":
      return "ChatGPT Pro";
    case "prolite":
      return "ChatGPT Pro Lite";
    case "team":
      return "ChatGPT Team";
    case "business":
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
      return "ChatGPT Business";
    case "enterprise":
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
      return "ChatGPT Enterprise";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu";
    default:
      return "ChatGPT";
  }
}

// ── Signing in ───────────────────────────────────────────────────────────────

/** How a login ended, from the `account/login/completed` notification. */
export interface CodexLoginCompletion {
  success: boolean;
  error: string | null;
}

/**
 * An OAuth flow the app-server is running for us. The app-server holds the
 * loopback listener, so the session must stay alive until the browser round trip
 * lands — hence a handle rather than a promise.
 */
export interface CodexLoginSession {
  /** The URL the user must open to authorize. */
  readonly authUrl: string;
  /** Abandon the flow (`account/login/cancel`) and shut the session down. */
  cancel(): Promise<void>;
  /** Shut the session down, leaving the flow alone. Idempotent, and a no-op
   *  while a {@link cancel} is still in flight. */
  close(): Promise<void>;
}

/**
 * Start a ChatGPT OAuth login and return once the app-server has handed back the
 * authorization URL. `onCompleted` fires exactly once, when the app-server
 * reports the flow finished — successfully or not — and is the only signal that
 * the credentials landed.
 *
 * Throws {@link CodexAccountUnsupportedError} when this codex has no
 * `account/login/start`; anything else is a transport failure.
 */
export async function startCodexLogin(
  opts: CodexAccountOptions,
  onCompleted: (completion: CodexLoginCompletion) => void,
): Promise<CodexLoginSession> {
  const client = await withTimeout(
    openSession(opts),
    ACCOUNT_TIMEOUT_MS,
    "codex app-server start",
  );

  let loginId: string | null = null;
  let announced = false;
  /** Set before any deliberate shutdown, so tearing the session down is never
   *  reported as the login failing. */
  let closing = false;
  const announce = (completion: CodexLoginCompletion) => {
    if (announced) return;
    announced = true;
    onCompleted(completion);
  };

  // Subscribed BEFORE the flow starts: a login the user completes instantly (an
  // already-authorized browser) can otherwise finish before we are listening.
  client.on("notification", (n: ServerNotification) => {
    if (n.method !== "account/login/completed") return;
    if (loginId && n.params.loginId && n.params.loginId !== loginId) return;
    announce({ success: n.params.success, error: n.params.error ?? null });
  });
  // The app-server dying mid-flow is a failure the caller must hear about —
  // otherwise the job sits "running" until its timeout. A shutdown we asked for
  // is not that.
  client.on("exit", () => {
    if (closing) return;
    announce({ success: false, error: "The Codex app-server stopped before sign-in finished." });
  });

  let started: LoginAccountResponse;
  try {
    started = (await withTimeout(
      client.request("account/login/start", { type: "chatgpt" }),
      ACCOUNT_TIMEOUT_MS,
      "account/login/start",
    )) as LoginAccountResponse;
  } catch (err) {
    await client.stop().catch(() => {});
    rethrowAsUnsupported("account/login/start", err);
  }

  if (started.type !== "chatgpt") {
    await client.stop().catch(() => {});
    throw new Error(`Codex started a ${started.type} login, which muxi-agent can't drive.`);
  }
  loginId = started.loginId;

  let cancelling: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (cancelling) return cancelling;
    closing = true;
    await client.stop().catch(() => {});
  };
  return {
    authUrl: started.authUrl,
    close,
    cancel(): Promise<void> {
      cancelling ??= (async () => {
        closing = true;
        try {
          await withTimeout(
            client.request("account/login/cancel", { loginId }),
            ACCOUNT_TIMEOUT_MS,
            "account/login/cancel",
          );
        } catch {
          // A cancel the app-server never acknowledged is still a cancel: the
          // process is about to be killed either way.
        }
        await client.stop().catch(() => {});
      })();
      return cancelling;
    },
  };
}

// ── Signing out ──────────────────────────────────────────────────────────────

/**
 * Drop the stored credentials in the Codex home this session targets.
 *
 * Codex removes the home's own `auth.json` ENTRY, not what it points at: run
 * against a home whose `auth.json` is a symlink and only the link goes, leaving
 * the real credentials in place. Callers that maintain such a link must sign out
 * of the home that owns the file.
 *
 * Throws {@link CodexAccountUnsupportedError} when this codex has no
 * `account/logout`.
 */
export async function codexLogout(opts: CodexAccountOptions = {}): Promise<void> {
  const client = await withTimeout(
    openSession(opts),
    ACCOUNT_TIMEOUT_MS,
    "codex app-server start",
  );
  try {
    await withTimeout(
      client.request("account/logout", undefined),
      ACCOUNT_TIMEOUT_MS,
      "account/logout",
    );
  } catch (err) {
    rethrowAsUnsupported("account/logout", err);
  } finally {
    await client.stop().catch(() => {});
  }
}
