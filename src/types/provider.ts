/**
 * Provider-facing schemas: the inputs a thread and a turn take, and the status,
 * model and usage objects a provider reports. Transport-agnostic: nothing here
 * is specific to Codex's protocol or the Claude Agent SDK.
 */

import { z } from "zod";

import { TurnTrigger } from "./events.ts";
import { DocumentAttachment, ImageAttachment } from "./shared.ts";

/** The two backends this package drives. */
export const ProviderId = z.enum(["claude", "codex"]);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * Three-state login. `unknown` is what a failed check produces (a timeout, a
 * CLI without the subcommand, a locked keychain) and must never read as
 * "signed out".
 */
export const AgentProviderAuthStatus = z.enum(["authenticated", "unauthenticated", "unknown"]);
export type AgentProviderAuthStatus = z.infer<typeof AgentProviderAuthStatus>;

/** The login behind a backend. `method` is the backend's own token for how it
 *  authenticates (`apiKey`, a subscription type, a Codex auth mode) and `label`
 *  display copy derived from it ("Claude Max 20x"). */
export const AgentProviderAuth = z.object({
  status: AgentProviderAuthStatus,
  method: z.string().optional(),
  label: z.string().optional(),
  email: z.string().optional(),
});
export type AgentProviderAuth = z.infer<typeof AgentProviderAuth>;

/**
 * Which binary a turn actually runs.
 *  - `bundled`    the Claude Agent SDK's own native CLI.
 *  - `path`       resolved from PATH.
 *  - `configured` an explicit path passed to the provider.
 */
export const AgentBinarySource = z.enum(["bundled", "path", "configured"]);
export type AgentBinarySource = z.infer<typeof AgentBinarySource>;

/** Result of probing a backend (binary, version, login). */
export const ProviderStatus = z.object({
  id: z.string(),
  found: z.boolean(),
  binPath: z.string().nullable(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
  /** The login check itself couldn't answer, so `loggedIn: false` means "we
   *  don't know", never "signed out". See `errors` for the cause. */
  loginUnknown: z.boolean().optional(),
  /** The three-state login and its display labels, when the probe read them. */
  auth: AgentProviderAuth.optional(),
  binarySource: AgentBinarySource.optional(),
  /** Whether the installed CLI offers a sign-out command. */
  supportsLogout: z.boolean().optional(),
  appServerAvailable: z.boolean(),
  /** MCP servers configured globally for the backend. Threads get theirs per
   *  thread, so in an isolated setup this is empty: anything listed here is a
   *  leak worth looking at. */
  mcpServers: z.array(z.string()),
  errors: z.array(z.string()),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/**
 * How a host gates the agent's tool calls, recorded on the thread. Providers
 * don't enforce it: every MCP tool call and every workspace-mode native call
 * reaches the host as an `approval.requested` whatever the mode, and the host's
 * policy decides.
 */
export const ApprovalMode = z.enum(["ask", "auto", "full"]);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/** One streamable-HTTP MCP server a thread may use. */
export const McpServerConfig = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** MCP server names become part of tool names (`mcp__<name>__<tool>` on
 *  Claude, config keys on Codex), so they stay simple. */
export const McpServerName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "letters, digits, - and _ only");

/** Config for starting a new agent thread. */
export const StartThreadInput = z.object({
  cwd: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  baseInstructions: z.string().optional(),
  developerInstructions: z.string().optional(),
  /** The ONLY MCP servers the thread sees. Omitted means none. */
  mcpServers: z.record(McpServerName, McpServerConfig).optional(),
  /** Claude gets WebSearch and WebFetch; Codex its live web search. */
  webSearch: z.boolean().optional(),
  /** The thread may start subagents (needs the provider's `subagent` option). */
  subagents: z.boolean().optional(),
  /** Claude gets AskUserQuestion: a question for the person arrives as a
   *  `userInput` approval (read it with `questionsOf`) and the answers go back
   *  on accept (`answersContent`). Codex asks through its own request either way. */
  askUser: z.boolean().optional(),
  approvalMode: ApprovalMode.optional(),
});
export type StartThreadInput = z.infer<typeof StartThreadInput>;

/**
 * Reasoning effort. An open string: each backend owns its vocabulary (Codex:
 * none…xhigh; Claude: low…max). The levels a model accepts come from
 * {@link AgentModel.reasoningEfforts}; a provider clamps what it receives.
 */
export const ReasoningEffort = z.string();
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ReasoningEffortOption = z.object({
  effort: ReasoningEffort,
  description: z.string().optional(),
});
export type ReasoningEffortOption = z.infer<typeof ReasoningEffortOption>;

/** An optional execution-speed tier a model offers (Codex's `priority`). */
export const ServiceTierOption = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type ServiceTierOption = z.infer<typeof ServiceTierOption>;

/** A model the backend offers, from its live, login-dependent catalog. */
export const AgentModel = z.object({
  /** Catalog id used to select the model on a turn. */
  id: z.string(),
  /** Underlying model slug. */
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  /** Reasoning-effort levels this model supports, in catalog order. */
  reasoningEfforts: z.array(ReasoningEffortOption),
  defaultEffort: ReasoningEffort,
  serviceTiers: z.array(ServiceTierOption).optional(),
  /** True for the catalog's default model. */
  isDefault: z.boolean(),
  /** A newer model replaces this one; still usable. */
  superseded: z.boolean().optional(),
  /** When the backend retires this model, ISO 8601. */
  retiresAt: z.string().optional(),
  /** Owning provider id, when a host aggregates catalogs. */
  provider: z.string().optional(),
  /** Vendor label ("OpenAI", "Anthropic"). */
  vendor: z.string().optional(),
});
export type AgentModel = z.infer<typeof AgentModel>;

/**
 * One usage/limit window: a rolling quota bucket (a 5-hour or weekly window).
 * `usedPercent` is 0–100. Codex gives a machine-readable reset (`resetsAt`, ISO
 * 8601); Claude's fallback scrape gives only a label (`resetsLabel`).
 */
export const UsageWindow = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  resetsLabel: z.string().nullable(),
  /** The window's length in minutes, when known. */
  windowMins: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * A backend's subscription usage snapshot. A provider returns `null` instead
 * when it can't report limits at all (API-key auth, logged out, parse failure).
 * `scope` says how trustworthy the numbers are: `account` straight from the
 * service, `machine` counted on this device only.
 */
export const ProviderUsage = z.object({
  provider: z.string(),
  /** Plan/tier label when known ("Pro", "Max"). */
  plan: z.string().nullable(),
  windows: z.array(UsageWindow),
  scope: z.enum(["account", "machine"]),
  note: z.string().nullable(),
  /** When the snapshot was read, ISO 8601. */
  fetchedAt: z.string(),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** One turn's input: text plus optional per-turn overrides. */
export const TurnInput = z.object({
  text: z.string(),
  /** Images sent after the text. Needs a vision-capable model. */
  images: z.array(ImageAttachment).optional(),
  /** Documents (PDFs, text files) for the model to read with the text. Claude
   *  reads both kinds; Codex reads text and is told a PDF can't be read. */
  documents: z.array(DocumentAttachment).optional(),
  /** Override the model for this turn and later ones (sticky). */
  model: z.string().optional(),
  /** Override the reasoning effort for this turn and later ones (sticky). */
  effort: ReasoningEffort.optional(),
  /** Codex only: execution-speed tier. `null` restores standard. */
  serviceTier: z.string().nullable().optional(),
  /** Set when the system, not a person, starts the turn. Providers pass it
   *  through; a host's policy reads it. */
  trigger: TurnTrigger.optional(),
  /**
   * A JSON schema the turn's final answer must match. Claude returns it as
   * structured output; Codex constrains its last message to it. The parsed
   * value arrives as the last `agent.message.completed` text (JSON).
   */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /**
   * Claude only. `"auto"` lets Claude Code's auto mode classifier approve or
   * refuse calls that would otherwise reach `canUseTool`; the host's guard
   * still runs first, and what the classifier escalates still reaches
   * `canUseTool`. Default `"default"` (every call to `canUseTool`). Not sticky:
   * each turn says. A Codex turn refuses `"auto"`.
   */
  permissionMode: z.enum(["default", "auto"]).optional(),
  /**
   * Claude only. The MCP servers for this turn alone: a complete replacement
   * for the thread's (`{}` means none), never stored, so the next turn without
   * it goes back to the thread's. A host rotates a per-turn endpoint through
   * it. Its URLs and header values are redacted from the CLI's stderr log.
   * A Codex turn refuses it.
   */
  mcpServers: z.record(McpServerName, McpServerConfig).optional(),
});
export type TurnInput = z.infer<typeof TurnInput>;

/** A live or resumed agent thread. */
export const Thread = z.object({
  id: z.string(),
  cwd: z.string().nullable(),
  status: z.string(),
  model: z.string().nullable().optional(),
  provider: z.string().optional(),
});
export type Thread = z.infer<typeof Thread>;
