/**
 * A turn's hooks, put together, and the host's {@link ToolGuard} as one of them.
 *
 * Several parts of a turn register hooks (the plan, a workspace, subagents, the
 * guard), sometimes on the same event. They are merged by concatenating each
 * event's matchers, never by spreading objects, so no part silently replaces
 * another's `PreToolUse`. The CLI runs every matching hook and a deny from any
 * of them wins.
 */

import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";

import type { CompactionCallbacks, ToolGuard } from "../provider.ts";
import type { ToolDenial } from "../types/denial.ts";

type Hooks = NonNullable<Options["hooks"]>;

/** Each event's matchers from every part, in order. */
export function mergeHooks(...parts: Array<Hooks | null | undefined>): Hooks {
  const out: Hooks = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [event, matchers] of Object.entries(part) as [keyof Hooks, Hooks[keyof Hooks]][]) {
      if (!matchers?.length) continue;
      out[event] = [...(out[event] ?? []), ...matchers];
    }
  }
  return out;
}

/** The guard as a `PreToolUse` hook on every tool, the main agent's and its
 *  subagents' calls alike. A guard that throws refuses the call. */
export function guardHooks(threadId: string, guard: ToolGuard | undefined, denials?: Map<string, ToolDenial>): Hooks | null {
  if (!guard) return null;
  const handle = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const reason = guardReason(guard, {
      threadId,
      tool: input.tool_name,
      input: (input.tool_input ?? {}) as Record<string, unknown>,
      ...(input.agent_id != null ? { agentId: input.agent_id } : {}),
    });
    if (!reason) return { continue: true };
    // The SDK's own denial event doesn't cover hook denials: the host says who refused.
    if (denials && input.tool_use_id) denials.set(input.tool_use_id, { by: "guard", reason });
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
    };
  };
  return { PreToolUse: [{ hooks: [handle] }] };
}

/** The guard's answer; a guard that throws refuses (fail closed). */
export function guardReason(guard: ToolGuard, call: Parameters<ToolGuard>[0]): string | null {
  try {
    return guard(call);
  } catch (err) {
    return `Refused: the host's check failed (${(err as Error).message}).`;
  }
}

/**
 * The host's {@link CompactionCallbacks} as hooks: `PreCompact`, `PostCompact`,
 * and the `SessionStart` the CLI fires as a compacted conversation resumes,
 * which is the one that can add context. A subagent's compaction is its own
 * business, and a callback that throws must not cost the thread its compaction.
 */
export function compactionHooks(threadId: string, callbacks: CompactionCallbacks | undefined): Hooks | null {
  if (!callbacks) return null;
  const guarded = async <T>(name: string, run: () => T | Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      console.warn(`[muxi-agent:claude] compaction callback "${name}" failed: ${(err as Error).message}`);
      return null;
    }
  };
  const handle = async (input: HookInput) => {
    if (input.agent_id != null) return { continue: true };
    if (input.hook_event_name === "PreCompact" && callbacks.before) {
      const { trigger, custom_instructions } = input;
      await guarded("before", () => callbacks.before?.({ threadId, trigger, instructions: custom_instructions || null }));
    }
    if (input.hook_event_name === "PostCompact" && callbacks.after) {
      const { trigger, compact_summary } = input;
      await guarded("after", () => callbacks.after?.({ threadId, trigger, summary: compact_summary }));
    }
    if (input.hook_event_name === "SessionStart" && input.source === "compact" && callbacks.contextAfter) {
      const additionalContext = await guarded("contextAfter", () => callbacks.contextAfter?.({ threadId }));
      if (additionalContext) return { hookSpecificOutput: { hookEventName: "SessionStart" as const, additionalContext } };
    }
    return { continue: true };
  };
  return {
    ...(callbacks.before ? { PreCompact: [{ hooks: [handle] }] } : {}),
    ...(callbacks.after ? { PostCompact: [{ hooks: [handle] }] } : {}),
    ...(callbacks.contextAfter ? { SessionStart: [{ hooks: [handle] }] } : {}),
  };
}
