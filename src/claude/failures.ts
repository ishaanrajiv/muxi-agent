/**
 * How a Claude turn ends badly: the `error.raised` code a failure maps to, the
 * outcome of a turn's `result` message, and the sentences retries, refusals
 * and blocking rate limits put on the turn.
 */

import type { ErrorCode } from "../types/index.ts";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import { LOGGED_OUT_RE } from "./auth.ts";

/** Error texts that mean the account is out of quota. */
const USAGE_LIMIT_RE = /\b(usage limit|rate limit|credit balance is too low)\b/i;

/** Error texts that mean the request never reached (or came back from) the API. */
const NETWORK_RE =
  /\b(fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network error|connection error)\b/i;

/**
 * Map a terminal Claude failure sentence onto a canonical `error.raised` code, so
 * the UI can offer the right remedy (sign in / retry) instead of raw prose.
 * Anything we can't place stays the honest generic `turn_failed`.
 */
export function classifyClaudeFailure(
  message: string,
): "not_logged_in" | "usage_limit" | "network" | "turn_failed" {
  if (LOGGED_OUT_RE.test(message)) return "not_logged_in";
  if (USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (NETWORK_RE.test(message)) return "network";
  return "turn_failed";
}

/** Whether a rate-limit event blocks the turn: the window is rejected and no
 *  extra usage covers it. A normal event can carry `overageStatus: "rejected"`
 *  while `status` is `allowed`, so the overage fields alone never block. */
export function isRateLimitBlocked(info: SDKRateLimitInfo): boolean {
  if (info.status !== "rejected") return false;
  const overageCovers =
    info.isUsingOverage === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning";
  return !overageCovers;
}

/** How a turn's `result` message ends the turn. */
export type ClaudeResultOutcome =
  | { kind: "completed" }
  /** The turn stopped because the caller interrupted it. A clean end, not a failure:
   *  the stop warning is already on the turn. */
  | { kind: "interrupted" }
  | { kind: "failed"; code: ErrorCode; message: string };

/** Terminal reasons the CLI reports after `interrupt()` lands mid-stream or
 *  mid-tool. */
const ABORTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

/** A result message, as much of either variant as {@link claudeResultOutcome}
 *  reads. */
interface ResultFrame {
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  startup_failure_reason?: string;
  api_error_status?: number | null;
}

/** What the turn saw before its result that can name a failure better than
 *  the result's own prose. */
export interface ClaudeFailureEvidence {
  /** The `error` on the last top-level assistant message, cleared by a later
   *  one without it. */
  assistantError?: string | null;
  /** The sentence a rejected `rate_limit_event` put on the turn. */
  usageLimitMessage?: string | null;
}

/** Startup failures that mean the account or its gateway refused us. */
const STARTUP_AUTH_REASONS: ReadonlySet<string> = new Set([
  "org_pin_api_key_conflict",
  "org_verify_failed",
  "org_pin_mismatch",
  "gateway_signin_required",
  "gateway_access_denied",
]);

function startupFailureCode(reason: string): ErrorCode {
  if (STARTUP_AUTH_REASONS.has(reason)) return "not_logged_in";
  if (reason === "cli_version_too_old") return "cli_outdated";
  if (reason === "proxy_invalid") return "network";
  return "turn_failed";
}

/** Terminal reasons specific enough to name the failure. The rest (model_error,
 *  max_turns, hook_stopped, api_error, ...) fall through to the other signals. */
const TERMINAL_REASON_CODES: Readonly<Record<string, ErrorCode>> = {
  blocking_limit: "usage_limit",
  prompt_too_long: "context_full",
  rapid_refill_breaker: "context_full",
};

const ASSISTANT_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  authentication_failed: "not_logged_in",
  oauth_org_not_allowed: "not_logged_in",
  rate_limit: "usage_limit",
  billing_error: "usage_limit",
  overloaded: "overloaded",
  server_error: "network",
};

function apiStatusCode(status: number | null | undefined): ErrorCode | null {
  if (status == null) return null;
  if (status === 401 || status === 403) return "not_logged_in";
  if (status === 429) return "usage_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "network";
  return null;
}

/** The code the prose gives, or the turn's blocking rate limit when the prose
 *  is generic. */
function proseCode(message: string, evidence: ClaudeFailureEvidence): ErrorCode {
  const code = classifyClaudeFailure(message);
  return code === "turn_failed" && evidence.usageLimitMessage ? "usage_limit" : code;
}

/**
 * Classify a `result` message. Error results carry their sentences in
 * `errors[]` (never `result`, which only the success variant has); the CLI's own
 * `[ede_diagnostic]` lines are internal and skipped. A success flagged
 * `is_error` (an API error that ended the turn) states itself in `result`.
 *
 * The code comes from the most specific signal present: the startup failure
 * reason, the terminal reason, the last assistant message's error, the API
 * status, and only then the prose. When the prose names no cause either, a
 * blocking rate limit seen earlier in the turn does.
 */
export function claudeResultOutcome(
  msg: ResultFrame,
  evidence: ClaudeFailureEvidence = {},
): ClaudeResultOutcome {
  if (msg.terminal_reason && ABORTED_TERMINAL_REASONS.has(msg.terminal_reason)) {
    return { kind: "interrupted" };
  }
  if (msg.subtype === "success" && !msg.is_error) return { kind: "completed" };
  const stated =
    msg.subtype === "success"
      ? msg.result?.trim()
      : msg.errors?.find((e) => e.trim() && !e.startsWith("[ede_diagnostic]"))?.trim();
  const message = stated || `Claude turn ended: ${msg.subtype}`;
  const code =
    (msg.startup_failure_reason ? startupFailureCode(msg.startup_failure_reason) : null) ??
    (msg.terminal_reason ? TERMINAL_REASON_CODES[msg.terminal_reason] : undefined) ??
    (evidence.assistantError ? ASSISTANT_ERROR_CODES[evidence.assistantError] : undefined) ??
    apiStatusCode(msg.api_error_status) ??
    proseCode(message, evidence);
  // A usage-limit stop names the window and its reset when the turn saw the
  // rate-limit event that said so; the CLI's own line names neither reliably.
  if (code === "usage_limit" && evidence.usageLimitMessage) {
    return { kind: "failed", code, message: evidence.usageLimitMessage };
  }
  return { kind: "failed", code, message };
}

/** One `api_retry` frame, as much of it as the sentence below needs. */
interface RetryFrame {
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
}

/**
 * The sentence an `api_retry` frame puts on the turn: which attempt, out of how
 * many, and what failed. Deliberately plain: the reader's question during a retry
 * storm is "is anything happening", and the counters answer it.
 */
export function retryMessage(msg: RetryFrame): string {
  const attempt = typeof msg.attempt === "number" ? msg.attempt : null;
  const max = typeof msg.max_retries === "number" ? msg.max_retries : null;
  const of = attempt != null && max != null ? ` (attempt ${attempt}/${max})` : "";
  // `error` is the SDK's own class name; `error_status` is null for connection
  // failures that never got an HTTP response.
  const cause = msg.error ? msg.error.replace(/_/g, " ") : "the request failed";
  const status = typeof msg.error_status === "number" ? ` ${msg.error_status}` : "";
  const delay =
    typeof msg.retry_delay_ms === "number" && msg.retry_delay_ms > 0
      ? `; retrying in ${Math.round(msg.retry_delay_ms / 100) / 10}s`
      : "; retrying";
  return `Claude's API call hit ${cause}${status}${of}${delay}.`;
}

/** One refusal notice (`model_refusal_fallback` / `model_refusal_no_fallback`). */
interface RefusalFrame {
  subtype?: string;
  original_model?: string;
  fallback_model?: string;
  api_refusal_category?: string | null;
  api_refusal_explanation?: string | null;
  retracted_message_uuids?: string[];
}

/**
 * The sentence a model refusal puts on the turn. The fallback variant also names
 * how much already-delivered content the CLI retracted: the contract has no
 * retraction event (a `*.completed` item is final once emitted), so saying it is
 * the only way the reader learns that what they saw was withdrawn and replaced.
 */
export function refusalMessage(msg: RefusalFrame): string {
  const model = msg.original_model ? `Claude's ${msg.original_model}` : "The model";
  const why = msg.api_refusal_category ? ` (${msg.api_refusal_category})` : "";
  const retracted = msg.retracted_message_uuids?.length ?? 0;
  const withdrawn = retracted
    ? ` It withdrew ${retracted} message${retracted === 1 ? "" : "s"} it had already sent, so anything above this line that it replaced no longer stands.`
    : "";
  if (msg.subtype === "model_refusal_fallback") {
    const fallback = msg.fallback_model ? ` on ${msg.fallback_model}` : " on a fallback model";
    return `${model} declined this request${why} and it was retried${fallback}.${withdrawn}`;
  }
  const explanation = msg.api_refusal_explanation ? ` ${msg.api_refusal_explanation}` : "";
  return `${model} declined this request${why} and no fallback model was available.${explanation}${withdrawn}`;
}
