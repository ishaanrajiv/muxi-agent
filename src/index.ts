/**
 * `@ishaanrajiv/muxi-agent`: Claude and Codex agent backends behind one
 * {@link AgentProvider} interface.
 *
 * Depend on {@link AgentProvider} and the types in `./types` (re-exported
 * here), not on `CodexClient` or the generated Codex protocol.
 */

export type {
  AgentProvider,
  ApprovalRequestId,
  HistoryCut,
  ResumeThreadState,
  RollbackResult,
  UtilityTurnInput,
  UtilityTurnResult,
  WorkspaceSettings,
  ToolGuard,
  ToolGuardCall,
} from "./provider.ts";
export { composeSystemPrompt, InvalidRollbackError } from "./provider.ts";
export { PendingApprovalNotFoundError } from "./shared.ts";
export type { SubagentRole } from "./subagents.ts";

export { ClaudeAgentProvider, type ClaudeAgentProviderOptions } from "./claude-provider.ts";
export {
  bundledClaudeExecutable,
  claudeOnPath,
  resolveClaudeExecutable,
  resetClaudeExecutableCache,
  type ClaudeExecutable,
} from "./claude-binary.ts";

export { CODEX_WEB_AND_SHELL, CodexAgentProvider, type CodexAgentProviderOptions } from "./codex-provider.ts";
export { managedCodexConfig, prepareCodexHome, type PrepareCodexHomeOptions } from "./codex/home.ts";
export { CodexClient, type CodexClientOptions } from "./codex-client.ts";
export {
  authFromAccount,
  codexLogout,
  CodexAccountUnsupportedError,
  readCodexAccount,
  startCodexLogin,
  type CodexAccountOptions,
  type CodexLoginCompletion,
  type CodexLoginSession,
} from "./codex-account.ts";
export {
  notificationToEvent,
  requestToApproval,
  decisionToWire,
  decisionToWireForRequest,
  isUserFacingRequestMethod,
  questionEnvelopeSummary,
} from "./normalize.ts";
export { probe as probeCodex, type ProbeResult } from "./probe.ts";

export * from "./types/index.ts";
