/**
 * Live smoke test against the logged-in `claude` and `codex` on this machine.
 * For each provider: probe, list models, read usage, run a utility turn with an
 * output schema, and run a two-turn thread that calls `echo` on a throwaway
 * local MCP server, accepting each approval it raises.
 *
 *   node scripts/smoke.ts [claude|codex ...]
 *
 * Models: CLAUDE_SMOKE_MODEL (default claude-haiku-5-5) and CODEX_SMOKE_MODEL
 * (default: the smallest model the Codex catalog lists). Codex runs under a
 * scratch CODEX_HOME in `.smoke/` that links the user's login. Spends a little
 * of each subscription's quota.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { ClaudeAgentProvider } from "../src/claude-provider.ts";
import { CodexAgentProvider } from "../src/codex-provider.ts";
import type { AgentProvider } from "../src/provider.ts";
import type { AgentModel, TurnStreamEvent } from "../src/types/index.ts";
import { startEchoServer } from "./lib/echo-mcp-server.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SCRATCH = join(ROOT, ".smoke");
const CWD = join(SCRATCH, "cwd");
mkdirSync(CWD, { recursive: true });

const log = (provider: string, step: string, data: unknown) =>
  console.log(`[${provider}] ${step}: ${typeof data === "string" ? data : JSON.stringify(data)}`);

/** The cheapest-looking Codex model: a mini/nano/luna tier first, else the
 *  catalog default. */
function cheapestCodexModel(models: AgentModel[]): AgentModel | undefined {
  const live = models.filter((m) => !m.superseded);
  for (const tier of ["nano", "mini", "luna"]) {
    const hit = live.find((m) => m.id.toLowerCase().includes(tier));
    if (hit) return hit;
  }
  return live.find((m) => m.isDefault) ?? live[0];
}

/** Collapse runs of the same event type: "agent.message.delta ×8". */
function summarize(events: TurnStreamEvent[]): string[] {
  const out: Array<[string, number]> = [];
  for (const e of events) {
    const label = e.type === "error.raised" ? `error.raised:${e.code}${e.fatal ? "" : ":warning"}` : e.type;
    const last = out.at(-1);
    if (last && last[0] === label) last[1]++;
    else out.push([label, 1]);
  }
  return out.map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
}

async function runTurn(provider: AgentProvider, threadId: string, text: string) {
  const events: TurnStreamEvent[] = [];
  const approvals: string[] = [];
  for await (const ev of provider.sendTurn(threadId, { text })) {
    events.push(ev);
    if (ev.type === "approval.requested") {
      approvals.push(`${ev.request.kind}: ${ev.request.summary}`);
      await provider.resolveApproval(ev.request.requestId, { action: "accept" });
    }
  }
  const tools = events.flatMap((e) =>
    e.type === "tool.completed" ? [`${e.server}/${e.tool} -> ${e.status}`] : [],
  );
  const answer = events.filter((e) => e.type === "agent.message.completed").map((e) => e.text).join(" | ");
  const errors = events.flatMap((e) => (e.type === "error.raised" ? [`${e.code}: ${e.message}`] : []));
  return { events: summarize(events), approvals, tools, answer, errors };
}

async function smoke(name: string, provider: AgentProvider, pickModel: (models: AgentModel[]) => string) {
  const failures: string[] = [];
  const status = await provider.probe();
  // The login's email stays out of the output.
  const { email: _email, ...auth } = status.auth ?? { status: "unknown" };
  log(name, "probe", { found: status.found, version: status.version, loggedIn: status.loggedIn, auth, errors: status.errors });
  if (!status.found) return [`${name}: not installed`];

  const models = await provider.listModels();
  const model = pickModel(models);
  log(name, "listModels", { count: models.length, ids: models.map((m) => m.id), using: model });

  const usage = await provider.getUsage();
  log(name, "getUsage", usage ? usage.windows.map((w) => `${w.label} ${w.usedPercent}%`) : null);

  const utility = await provider.runUtilityTurn({
    model,
    effort: "low",
    cwd: CWD,
    systemInstructions: "You answer arithmetic questions.",
    prompt: "What is 17 + 25? Give the sum as a number.",
    outputSchema: {
      type: "object",
      properties: { sum: { type: "number" } },
      required: ["sum"],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
  });
  log(name, "utility turn", { output: utility.output, durationMs: utility.durationMs });
  if ((utility.output as { sum?: unknown } | null)?.sum !== 42) failures.push(`${name}: utility output ${JSON.stringify(utility.output)}`);

  const echo = await startEchoServer();
  try {
    const thread = await provider.startThread({
      cwd: CWD,
      model,
      effort: "low",
      baseInstructions: "You are a terse assistant. Use the tools you are given when asked.",
      mcpServers: { lab: { type: "http", url: echo.url } },
    });
    log(name, "startThread", { id: thread.id, model: thread.model });
    for (const [i, word] of ["ping-one", "ping-two"].entries()) {
      const turn = await runTurn(
        provider,
        thread.id,
        `Call the echo tool on the lab server with the text "${word}", then reply with only what it returned.`,
      );
      log(name, `turn ${i + 1}`, turn);
      if (!echo.calls.some((c) => (c.args as { text?: string }).text === word)) failures.push(`${name}: echo never ran for ${word}`);
      if (turn.approvals.length === 0) failures.push(`${name}: turn ${i + 1} raised no approval`);
      if (!turn.answer.includes(word)) failures.push(`${name}: turn ${i + 1} answer lacks ${word}`);
    }
    log(name, "echo server calls", echo.calls);
    await provider.releaseThread(thread.id);
  } finally {
    await echo.close();
  }
  return failures;
}

const wanted = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]);
const failures: string[] = [];

if (wanted.has("claude")) {
  const claude = new ClaudeAgentProvider({ defaultCwd: CWD });
  const model = process.env.CLAUDE_SMOKE_MODEL ?? "claude-haiku-5-5";
  try {
    failures.push(...(await smoke("claude", claude, () => model)));
  } catch (err) {
    failures.push(`claude: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

if (wanted.has("codex")) {
  const codex = new CodexAgentProvider({ codexHome: join(SCRATCH, "codex-home"), cwd: CWD });
  try {
    failures.push(
      ...(await smoke("codex", codex, (models) => {
        const id = process.env.CODEX_SMOKE_MODEL ?? cheapestCodexModel(models)?.id;
        if (!id) throw new Error("the Codex catalog is empty");
        return id;
      })),
    );
  } catch (err) {
    failures.push(`codex: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    await codex.stop();
  }
}

if (failures.length) {
  console.log(`\nSMOKE FAILED\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nSMOKE OK");
}
