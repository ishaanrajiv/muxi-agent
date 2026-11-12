/**
 * The Claude backend's status probe: which binary a turn would run, its
 * version, whether it is signed in and as what, and whether it can sign out.
 */

import type { AgentProviderAuth, ProviderStatus } from "../types/index.ts";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeExecutable } from "../claude-binary.ts";
import { errorMessage, loadExecFile } from "../shared.ts";
import { sdkExecutablePath, withIdleSession } from "./sdk.ts";

/** How long the account probe waits for a CLI session to finish initializing.
 *  Generous because a third-party backend (Bedrock/Vertex) refreshes credentials
 *  inside init; a short budget reported those installs as unverified. */
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/** What {@link probeClaude} needs from the provider. */
export interface ClaudeProbeTarget {
  id: string;
  /** An explicit `claude` path from the caller, if any. */
  configuredPath: string | undefined;
  /** Test seam replacing the SDK's `query()`. */
  queryFn: typeof query | undefined;
}

/** `execFile`, promisified, as far as the probe calls it. */
type Exec = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

/**
 * Detect the backend by probing THE BINARY A TURN WOULD RUN — the SDK's
 * bundled native CLI in a packaged build, an explicit override, else a PATH
 * copy (see {@link resolveClaudeExecutable}). Judging PATH `claude` instead is
 * what let a packaged app with an empty PATH report Claude missing while its
 * turns ran fine.
 *
 * Auth is read from a live CLI session's initialization result — the SDK's own
 * account view, which carries the subscription label and email a Settings row
 * shows and is the same channel a turn authenticates through. An account the
 * CLI can't describe falls back to `claude auth status --json`, whose envelope
 * is the only source that says "signed out" definitively. Neither answering is
 * `unknown`, never "signed out": a probe that didn't answer is no evidence.
 */
export async function probeClaude(target: ClaudeProbeTarget): Promise<ProviderStatus> {
  const errors: string[] = [];
  const exec = await loadExecFile();
  const exe = resolveClaudeExecutable(target.configuredPath);
  if (!exe) {
    return {
      id: target.id,
      found: false,
      binPath: null,
      version: null,
      loggedIn: false,
      loginUnknown: true,
      auth: { status: "unknown" },
      supportsLogout: false,
      appServerAvailable: false,
      mcpServers: [],
      errors: ["No Claude Code executable — none bundled with the SDK, and none on PATH."],
    };
  }

  let version: string | null = null;
  try {
    const { stdout } = await exec(exe.path, ["--version"], { timeout: 5000 });
    // "2.1.207 (Claude Code)" — keep the first semver-ish token.
    version = stdout.match(/\d+\.\d+[\w.-]*/)?.[0] ?? stdout.trim();
  } catch (err) {
    errors.push(errorMessage(err));
  }

  const [auth, supportsLogout] = await Promise.all([
    probeAuth(exec, exe.path, errors, target),
    claudeOffersLogout(exec, exe.path, version),
  ]);
  return {
    id: target.id,
    found: true,
    binPath: exe.path,
    binarySource: exe.source,
    version,
    loggedIn: auth.status === "authenticated",
    ...(auth.status === "unknown" ? { loginUnknown: true } : {}),
    auth,
    supportsLogout,
    appServerAvailable: true,
    mcpServers: [],
    errors,
  };
}

/** The login half of {@link probeClaude}: the SDK account view first, the CLI's own
 *  `auth status` envelope as the only definitive "signed out". */
async function probeAuth(
  exec: Exec,
  bin: string,
  errors: string[],
  target: ClaudeProbeTarget,
): Promise<AgentProviderAuth> {
  // An API key settles it without spawning anything — it's what the SDK will
  // use, ahead of any CLI login.
  if (process.env.ANTHROPIC_API_KEY) {
    return { status: "authenticated", method: "apiKey", label: "Anthropic API key" };
  }
  const account = await probeAccount(target);
  if (account) {
    const labelled = claudeAuthLabels(account);
    // An account object with nothing in it is what a signed-OUT CLI reports:
    // initialization is local and succeeds either way. Only an account that
    // describes itself is evidence of a login.
    if (labelled) return { status: "authenticated", ...labelled };
  }
  let stdout = "";
  let probeError: unknown;
  try {
    // `auth status` exits 1 when signed out but still prints its JSON on
    // stdout — that IS the verdict, so read it before the error text.
    ({ stdout } = await exec(bin, ["auth", "status", "--json"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    probeError = err;
    stdout = execStdout(err);
  }
  const verdict = claudeLoginVerdict(stdout, probeError);
  if (verdict.detail) errors.push(verdict.detail);
  if (verdict.loggedIn === true) return { status: "authenticated" };
  if (verdict.loggedIn === false) return { status: "unauthenticated" };
  return { status: "unknown" };
}

/**
 * The CLI's own account view, read from a session that never takes a turn: the
 * prompt is a stream that never yields, so the CLI finishes its local
 * initialization (which is where `account` comes from) and is aborted before
 * any request reaches Anthropic. Costs no tokens and touches no quota.
 *
 * Generous timeout on purpose — a third-party backend (Bedrock/Vertex) runs a
 * credential refresh inside initialization, and a short budget expired mid-init
 * and reported every such install as unverified.
 */
async function probeAccount(target: ClaudeProbeTarget): Promise<AccountInfo | undefined> {
  try {
    return await withIdleSession(
      target.queryFn,
      sdkExecutablePath(target.configuredPath),
      async (q) => (await q.initializationResult()).account,
      CAPABILITIES_PROBE_TIMEOUT_MS,
    );
  } catch {
    return undefined;
  }
}

/** What the login probe learned: `true`/`false` when the CLI itself reported a
 *  login state, `null` when the probe failed and therefore says nothing about it
 *  (`detail` then carries the failure for `ProviderStatus.errors`). */
export interface ClaudeLoginVerdict {
  loggedIn: boolean | null;
  detail?: string;
}

/** Subscription tokens the CLI reports, mapped to the plan name a person knows.
 *  An unlisted token falls back to a title-cased version of itself, so a new plan
 *  reads sensibly instead of vanishing. */
const SUBSCRIPTION_LABELS: Record<string, string> = {
  claudefreesubscription: "Claude Free",
  claudeprosubscription: "Claude Pro",
  claudemaxsubscription: "Claude Max",
  claudemax5xsubscription: "Claude Max 5x",
  claudemax20xsubscription: "Claude Max 20x",
  claudeteamsubscription: "Claude Team",
  claudeenterprisesubscription: "Claude Enterprise",
  free: "Claude Free",
  pro: "Claude Pro",
  max: "Claude Max",
  max5: "Claude Max 5x",
  max20: "Claude Max 20x",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
};

/** Third-party backends the CLI can authenticate against instead of Anthropic
 *  first-party OAuth. Their credentials live outside Claude (AWS, gcloud), so the
 *  row names the backend rather than a plan. */
const API_PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Azure AI Foundry",
  anthropicAws: "Anthropic on AWS",
  anthropicGoogleCloud: "Anthropic on Google Cloud",
  mantle: "Mantle",
  gateway: "Enterprise gateway",
};

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** `claude auth --help` answers, keyed by binary AND version so an in-place
 *  update is re-read rather than served from a stale entry. */
const logoutSupport = new Map<string, boolean>();

/**
 * Whether this Claude build's `auth` subcommand offers `logout`. Read from the
 * CLI's own help text: `auth logout` arrived partway through 2.x, and a version
 * comparison would be a guess about a boundary Anthropic never published. A
 * build without it gets no sign-out control at all.
 */
async function claudeOffersLogout(
  exec: Exec,
  bin: string,
  version: string | null,
): Promise<boolean> {
  const key = `${bin}@${version ?? "?"}`;
  const cached = logoutSupport.get(key);
  if (cached !== undefined) return cached;
  let offers = false;
  try {
    const { stdout } = await exec(bin, ["auth", "--help"], { timeout: 10_000 });
    offers = claudeHelpOffersLogout(stdout);
  } catch {
    // No `auth` subcommand at all, or the CLI didn't answer: offer nothing.
  }
  logoutSupport.set(key, offers);
  return offers;
}

/** Whether a `claude auth --help` listing contains a `logout` COMMAND. Anchored
 *  to a command line (leading indent, then the name) so a description that
 *  merely mentions signing out doesn't count as the command existing. */
export function claudeHelpOffersLogout(help: string): boolean {
  return /^\s+logout\b/m.test(help);
}

/**
 * Display labels for a CLI account, or undefined when the account describes
 * nothing — a signed-OUT CLI still initializes locally and reports an empty
 * account, so "there is an account object" is not evidence of a login. Only a
 * subscription, an API-key token source, a third-party backend, or an email is.
 */
export function claudeAuthLabels(
  account: Pick<AccountInfo, "email" | "subscriptionType" | "tokenSource" | "apiProvider">,
): Omit<AgentProviderAuth, "status"> | undefined {
  const email = account.email?.trim() || undefined;
  const source = account.tokenSource?.toLowerCase().replace(/[\s_-]+/g, "");
  if (source === "apikey" || source === "anthropicapikey" || source === "anthropicauthtoken") {
    return { method: "apiKey", label: "Anthropic API key", ...(email ? { email } : {}) };
  }
  const subscription = account.subscriptionType?.trim();
  if (subscription) {
    const key = subscription.toLowerCase().replace(/[\s_-]+/g, "");
    return {
      method: subscription,
      label: SUBSCRIPTION_LABELS[key] ?? titleCase(subscription),
      ...(email ? { email } : {}),
    };
  }
  const apiProvider = account.apiProvider;
  if (apiProvider && apiProvider !== "firstParty") {
    return {
      method: apiProvider,
      label: API_PROVIDER_LABELS[apiProvider] ?? titleCase(apiProvider),
      ...(email ? { email } : {}),
    };
  }
  return email ? { email } : undefined;
}

/** Error texts that unambiguously mean "signed out", not "the probe broke". */
export const LOGGED_OUT_RE =
  /\b(invalid api key|not logged in|please run\s+\/?login|unauthorized|authentication failed|oauth token (?:has )?expired)\b/i;

/**
 * Read a login verdict out of a `claude auth status --json` run: `stdout` is
 * whatever the CLI printed, `error` the rejection when the call failed (it exits
 * non-zero while signed out, and still prints the JSON). The envelope's
 * `loggedIn` is the CLI's own answer and settles it either way; an auth failure
 * in the error text also settles it. Anything else — a timeout, a spawn failure,
 * an older CLI whose `auth` subcommand doesn't exist — is unknown, and neither a
 * logged-in nor a logged-out claim.
 */
export function claudeLoginVerdict(stdout: string, error?: unknown): ClaudeLoginVerdict {
  try {
    const envelope = JSON.parse(stdout) as { loggedIn?: unknown };
    if (typeof envelope.loggedIn === "boolean") return { loggedIn: envelope.loggedIn };
  } catch {
    /* not the JSON envelope — fall through to the error text */
  }
  if (error === undefined) {
    return {
      loggedIn: null,
      detail: "Could not verify the Claude Code login — `claude auth status` reported no status.",
    };
  }
  const message = errorMessage(error);
  if (LOGGED_OUT_RE.test(message)) return { loggedIn: false };
  return { loggedIn: null, detail: `Could not verify the Claude Code login — ${message}` };
}

/** The `stdout` an `execFile` rejection carries, when it carries one. */
function execStdout(error: unknown): string {
  const out = (error as { stdout?: unknown } | null)?.stdout;
  return typeof out === "string" ? out : "";
}
