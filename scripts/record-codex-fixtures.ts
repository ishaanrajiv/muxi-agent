#!/usr/bin/env node
/**
 * Record Codex app-server wire fixtures for the replay test
 * (`src/codex-replay.test.ts`).
 *
 * Each scenario runs one real turn through `CodexAgentProvider` with the wire
 * log on, then writes the frames, redacted, to
 * `fixtures/codex-<version>/<scenario>.ndjson`: a header line, then one
 * `{d, t, m}` frame per line. `scripts/lib/fixture-scrub.ts` then makes it
 * anonymous: shifted timestamps, synthetic ids, no plan or usage figures.
 *
 * Usage:
 *   node scripts/record-codex-fixtures.ts             # every scenario
 *   node scripts/record-codex-fixtures.ts steer       # just these
 *
 * Needs a logged-in codex on PATH. The agent's only tools come from a
 * throwaway local MCP server (`scripts/lib/echo-mcp-server.ts`: echo, ask,
 * save_note), and the provider runs under a scratch CODEX_HOME it prepares
 * itself, so the user's own Codex state is never touched. Approvals: `echo`
 * and `ask` are accepted, an `ask` question is answered "weekly", and every
 * other call is declined. `CODEX_FIXTURE_MODEL` picks the model (default: the
 * cheapest the catalog lists).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentEvent } from "../src/types/index.ts";
import { mcpToolCallOf } from "../src/types/index.ts";
import type { CodexClient } from "../src/codex-client.ts";
import { CodexAgentProvider } from "../src/codex-provider.ts";
import { startEchoServer, type EchoServer } from "./lib/echo-mcp-server.ts";
import { scrubFixture } from "./lib/fixture-scrub.ts";

const PKG_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SCENARIO_TIMEOUT_MS = 240_000;

function codexVersion(): string {
  const out = execFileSync("codex", ["--version"], { encoding: "utf8" });
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`could not read codex version from: ${out}`);
  return m[1];
}

// ── redaction ────────────────────────────────────────────────────────────────

const REDACT_KEYS = new Set([
  "email",
  "accountId",
  "account_id",
  "chatgptAccountId",
  "userId",
  "user_id",
  "installationId",
  "organizationId",
]);

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** The machine's name, which Codex reports (remote control's `serverName`). */
const HOST = hostname();

/** Strip what a fixture must not carry: account fields, email addresses, the
 *  host name and local paths. The echo server's results are the prompt's own
 *  words, so they stay. */
function redact(value: unknown, home: string, scratch: string): unknown {
  if (typeof value === "string") {
    const named = HOST.length >= 3 ? value.split(HOST).join("<host>") : value;
    return named
      .split(scratch)
      .join("<codex-home>")
      .split(home)
      .join("~")
      .replace(EMAIL_RE, "<email>");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, home, scratch));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = REDACT_KEYS.has(k) && v != null ? "<redacted>" : redact(v, home, scratch);
    }
    return out;
  }
  return value;
}

// ── scenarios ────────────────────────────────────────────────────────────────

interface Ctx {
  provider: CodexAgentProvider;
  threadId: string;
  model: string;
  /** The provider's raw client, for requests the provider has no method for. */
  client: CodexClient;
}

/** Drain one turn, answering approvals: `echo` and `ask` accepted (an `ask`
 *  question answered "weekly"), everything else declined. */
async function runTurn(
  ctx: Ctx,
  text: string,
  opts: {
    effort?: string;
    outputSchema?: Record<string, unknown>;
    onEvent?: (ev: AgentEvent) => Promise<void> | void;
  } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of ctx.provider.sendTurn(ctx.threadId, {
    text,
    model: ctx.model,
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
  })) {
    events.push(ev);
    if (ev.type === "approval.requested") {
      const call = mcpToolCallOf(ev.request);
      if (call) {
        const ok = call.tool === "echo" || call.tool === "ask";
        await ctx.provider.resolveApproval(ev.request.requestId, { action: ok ? "accept" : "decline" });
      } else if (ev.request.kind === "mcpElicitation") {
        await ctx.provider.resolveApproval(ev.request.requestId, { action: "accept", content: { answer: "weekly" } });
      } else {
        await ctx.provider.resolveApproval(ev.request.requestId, { action: "decline" });
      }
    }
    await opts.onEvent?.(ev);
  }
  return events;
}

const SCENARIOS: Record<string, (ctx: Ctx) => Promise<void>> = {
  "mcp-tool-call": async (ctx) => {
    await runTurn(
      ctx,
      "Call the echo tool once with the text 'hello fixture', then reply in one short sentence quoting what " +
        "it returned. Call no other tool.",
    );
  },

  "reasoning-plan": async (ctx) => {
    await runTurn(
      ctx,
      "Use your plan tool to lay out three short steps, marking each done as you go. Then tell me " +
        "what 17 * 23 is and whether the result is prime, showing your reasoning briefly. Do not " +
        "call any MCP tools.",
      { effort: "medium" },
    );
  },

  elicitation: async (ctx) => {
    await runTurn(
      ctx,
      "Call the ask tool once to ask me whether I want a daily or a weekly summary. Then answer in one " +
        "sentence based on my reply. Call no other tool.",
    );
  },

  "tool-declined": async (ctx) => {
    await runTurn(
      ctx,
      "Call the save_note tool once with the text 'buy milk', then tell me in one sentence whether it " +
        "worked. Call no other tool.",
    );
  },

  "structured-output": async (ctx) => {
    await runTurn(ctx, "Name one primary colour and how many letters its name has.", {
      outputSchema: {
        type: "object",
        properties: { colour: { type: "string" }, letters: { type: "integer" } },
        required: ["colour", "letters"],
        additionalProperties: false,
      },
    });
  },

  interrupt: async (ctx) => {
    let stopped = false;
    let turnId: string | null = null;
    await runTurn(ctx, "Write a 600-word essay on the history of the number zero.", {
      onEvent: async (ev) => {
        if (ev.type === "turn.started") turnId = ev.turnId;
        if (!stopped && turnId && (ev.type === "agent.message.delta" || ev.type === "agent.reasoning.delta")) {
          stopped = true;
          await ctx.provider.interrupt(ctx.threadId, turnId);
        }
      },
    });
  },

  steer: async (ctx) => {
    let steered = false;
    let turnId: string | null = null;
    await runTurn(
      ctx,
      "Call the echo tool once with the text 'steady', then write two sentences about what it returned.",
      {
        onEvent: async (ev) => {
          if (ev.type === "turn.started") turnId = ev.turnId;
          if (!steered && turnId && ev.type === "tool.started") {
            steered = true;
            await ctx.provider.steerTurn(ctx.threadId, turnId, "Also end your reply with the word banana.");
          }
        },
      },
    );
  },

  "compaction-manual": async (ctx) => {
    await runTurn(ctx, "Reply with the single word ready.");
    // Compaction runs outside any turn the provider drives: ask for it, then
    // wait for Codex to report the compaction item done (or its legacy signal).
    const done = new Promise<void>((resolveDone, reject) => {
      const timer = setTimeout(() => reject(new Error("compaction never completed")), 120_000);
      const onNotif = (n: { method: string; params: Record<string, unknown> }) => {
        const item = (n.params?.item ?? {}) as { type?: string };
        if ((n.method === "item/completed" && item.type === "contextCompaction") || n.method === "turn/completed") {
          clearTimeout(timer);
          ctx.client.removeListener("notification", onNotif);
          resolveDone();
        }
      };
      ctx.client.on("notification", onNotif);
    });
    await ctx.client.request("thread/compact/start", { threadId: ctx.threadId });
    await done;
    // Let any trailing notification (thread/compacted, token usage) land.
    await new Promise((r) => setTimeout(r, 2_000));
  },
};

// ── driver ───────────────────────────────────────────────────────────────────

/** The model to record with: `CODEX_FIXTURE_MODEL`, else the catalog's last
 *  visible model (the picker lists the strongest first). */
async function pickModel(codexHome: string): Promise<string> {
  if (process.env.CODEX_FIXTURE_MODEL) return process.env.CODEX_FIXTURE_MODEL;
  const provider = new CodexAgentProvider({ codexHome });
  try {
    const models = (await provider.listModels()).filter((m) => !m.superseded);
    const model = models[models.length - 1];
    if (!model) throw new Error("codex lists no models");
    return model.id;
  } finally {
    await provider.stop();
  }
}

async function record(name: string, outDir: string, version: string, echo: EchoServer, model: string): Promise<void> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
  const codexHome = mkdtempSync(join(tmpdir(), "muxi-agent-fixture-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "muxi-agent-fixture-cwd-"));
  const wireLog = join(codexHome, "wire.ndjson");
  const provider = new CodexAgentProvider({
    codexHome,
    cwd,
    wireLogPath: wireLog,
    turnTimeoutMs: SCENARIO_TIMEOUT_MS,
  });
  const client = (provider as unknown as { client: CodexClient }).client;
  try {
    const thread = await provider.startThread({
      cwd,
      model,
      baseInstructions: "You are a concise assistant. Follow the user's instructions exactly.",
      mcpServers: { echo: { type: "http", url: echo.url } },
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${name} timed out`)), SCENARIO_TIMEOUT_MS).unref(),
    );
    await Promise.race([scenario({ provider, threadId: thread.id, model, client }), timeout]);
  } finally {
    await provider.stop();
  }
  const frames = readFileSync(wireLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => redact(JSON.parse(line), homedir(), codexHome))
    .map((frame) => redactPort(frame, echo.url));
  const header = { header: { codex: version, scenario: name, model, recordedAt: new Date().toISOString() } };
  const file = join(outDir, `${name}.ndjson`);
  writeFileSync(file, scrubFixture([header, ...frames]).map((f) => JSON.stringify(f)).join("\n") + "\n");
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  console.log(`recorded ${name}: ${frames.length} frames -> ${file}`);
}

/** The echo server's random port, as a fixed placeholder. */
function redactPort(frame: unknown, url: string): unknown {
  return JSON.parse(JSON.stringify(frame).split(url).join("http://127.0.0.1:<port>/mcp"));
}

async function main(): Promise<void> {
  const version = codexVersion();
  const outDir = join(PKG_DIR, "fixtures", `codex-${version}`);
  mkdirSync(outDir, { recursive: true });
  const echo = await startEchoServer();
  const scratch = mkdtempSync(join(tmpdir(), "muxi-agent-fixture-models-"));
  try {
    const model = await pickModel(scratch);
    console.log(`recording with ${model}`);
    const names = process.argv.slice(2);
    for (const name of names.length ? names : Object.keys(SCENARIOS)) {
      try {
        await record(name, outDir, version, echo, model);
      } catch (err) {
        console.error(`FAILED ${name}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await echo.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

void main();
