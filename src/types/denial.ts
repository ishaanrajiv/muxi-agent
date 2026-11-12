/**
 * Who refused a tool call: on the main agent's `tool.completed` and on a
 * subagent's calls alike, so it sits apart from both.
 */

import { z } from "zod";

/**
 * Who refused a tool call, when it never ran because something said no.
 * - `guard`: the host's hard refusals (its `ToolGuard`), as a hook or before asking.
 * - `host`: the host's `canUseTool` answer (its policy or a person; the host knows which).
 * - `classifier`: Claude's auto mode classifier.
 * - `rule` / `mode`: the CLI's own permission rules or mode.
 * - `other`: refused, but nothing said by whom (the CLI's authoritative list
 *   named it, and neither the host's side nor the CLI's advisory did).
 */
export const ToolDenial = z.object({
  by: z.enum(["guard", "host", "classifier", "rule", "mode", "other"]),
  reason: z.string().optional(),
});
export type ToolDenial = z.infer<typeof ToolDenial>;
