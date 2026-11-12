/**
 * Reading an approval request's detail: the MCP tool call it confirms and that
 * call's arguments. A host's approval policy decides on what these read, and an
 * approval card shows it.
 *
 * Both providers send an MCP tool-call confirmation in one shape: Codex tags it
 * `_meta.codex_approval_kind: "mcp_tool_call"`, and the Claude bridge copies the
 * tag, the server name and the message (`toolPermission` in
 * `claude/permissions.ts`). An elicitation a tool raises itself (a question for
 * a person) carries no tag and is not a tool call.
 */

import type { ApprovalRequest } from "./approvals.ts";

type Detail = Pick<ApprovalRequest, "detail">;

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The server and tool a tool-call confirmation targets. */
export interface ToolCallInfo {
  /** The MCP server the call targets, as the thread's `mcpServers` names it,
   *  or null if unparseable. */
  server: string | null;
  /** The tool name, as the MCP server lists it, or null if unparseable. */
  tool: string | null;
}

/**
 * The tool call a confirmation asks to run, or null when the request isn't a
 * tool-call confirmation. The server comes from `detail.serverName`, else the
 * message ("Allow the <server> MCP server to run tool "<tool>"?"), which also
 * names the tool unless the detail carries it (`toolName` from the Claude
 * bridge, `_meta.tool_name` from current Codex builds).
 */
export function mcpToolCallOf(request: Detail): ToolCallInfo | null {
  const detail = record(request.detail);
  const meta = record(detail?._meta);
  if (meta?.codex_approval_kind !== "mcp_tool_call") return null;
  const message = typeof detail?.message === "string" ? detail.message : "";
  const server =
    typeof detail?.serverName === "string" && detail.serverName
      ? detail.serverName
      : (/Allow the (\S+) MCP server/.exec(message)?.[1] ?? null);
  const named = [detail?.toolName, meta.tool_name].find((v): v is string => typeof v === "string" && v !== "");
  const tool = named ?? /run tool "([^"]+)"/.exec(message)?.[1] ?? null;
  return { server, tool };
}

/**
 * The call's arguments, or null when the request carries none. The Claude
 * bridge and current Codex builds stamp them on `_meta.tool_params`. A host
 * that knows them from the call's `tool.started` may stamp them on
 * `detail.arguments`. `_meta.arguments` is read last, for a Codex build that
 * sends them there.
 */
export function toolArgsOf(request: Detail): Record<string, unknown> | null {
  const detail = record(request.detail);
  const meta = record(detail?._meta);
  return record(meta?.tool_params) ?? record(detail?.arguments) ?? record(meta?.arguments);
}

/** One question a model asks a person, read the same from either backend. */
export interface QuestionInfo {
  /** The backend's id for it: Codex's question id, Claude's question text. */
  id: string;
  question: string;
  /** A short label for the question (a chip), when the model gave one. */
  header?: string;
  /** Whether more than one option may be picked. */
  multiSelect: boolean;
  /** The choices offered; empty for a free-text question. A person may always
   *  answer in their own words instead. */
  options: { label: string; description?: string }[];
}

/**
 * The questions a `userInput` request asks, or null when it asks none: Claude's
 * `AskUserQuestion` (`detail.questions`, as the bridge passes them on) and
 * Codex's `item/tool/requestUserInput` (`params.questions`, each with an id).
 */
export function questionsOf(request: Pick<ApprovalRequest, "kind" | "detail">): QuestionInfo[] | null {
  if (request.kind !== "userInput") return null;
  const raw = record(request.detail)?.questions;
  if (!Array.isArray(raw)) return null;
  const out: QuestionInfo[] = [];
  for (const q of raw) {
    const r = record(q);
    const question = typeof r?.question === "string" ? r.question.trim() : "";
    if (!r || !question) continue;
    const options = (Array.isArray(r.options) ? r.options : [])
      .map((o) => record(o))
      .filter((o): o is Record<string, unknown> => !!o && typeof o.label === "string" && o.label.trim() !== "")
      .map((o) => ({
        label: (o.label as string).trim(),
        ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}),
      }));
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : question,
      question,
      ...(typeof r.header === "string" && r.header.trim() ? { header: r.header.trim() } : {}),
      multiSelect: r.multiSelect === true,
      options,
    });
  }
  return out.length ? out : null;
}

/**
 * The decision `content` that answers a `userInput` request: `answers` maps
 * each question's text to the answer (a picked label, labels joined by ", ",
 * or the person's own words). Unknown questions are dropped. Claude takes the
 * answers by question text, Codex by question id, as `{ answers: [text] }`.
 */
export function answersContent(
  request: Pick<ApprovalRequest, "kind" | "detail">,
  answers: Record<string, string>,
): { answers: Record<string, string> } | { answers: Record<string, { answers: string[] }> } {
  const questions = questionsOf(request) ?? [];
  const codex = questions.some((q) => q.id !== q.question);
  if (codex) {
    const out: Record<string, { answers: string[] }> = {};
    for (const q of questions) {
      const a = answers[q.question] ?? answers[q.id];
      if (typeof a === "string") out[q.id] = { answers: [a] };
    }
    return { answers: out };
  }
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = answers[q.question];
    if (typeof a === "string") out[q.question] = a;
  }
  return { answers: out };
}
