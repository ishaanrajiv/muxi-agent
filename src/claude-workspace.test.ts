/**
 * Workspace mode on the Claude backend, driven through the `queryFn` seam: the
 * options a workspace turn sends (cwd, tools, sandbox, env), the steering it
 * carries once, and how native tool calls bridge into `approval.requested` and
 * back.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { workspaceEnv } from "./claude/workspace.ts";
import type { WorkspaceSettings } from "./provider.ts";

type QueryArgs = Parameters<typeof query>[0];
type CanUseTool = NonNullable<NonNullable<QueryArgs["options"]>["canUseTool"]>;

const ROOT = "/srv/u/work/t1";
const SETTINGS: WorkspaceSettings = {
  root: ROOT,
  protectedPaths: ["/srv/u/data"],
  developerInstructions: "dev\n\nWORKSPACE STEERING",
  systemPrompt: "base\n\ndev\n\nWORKSPACE STEERING",
  instructions: "WORKSPACE STEERING",
  introduce: true,
  refusal: () => null,
  cacheDir: "/srv/u/cache",
};

interface Captured {
  options: NonNullable<QueryArgs["options"]>;
  firstPrompt: string;
}

/** A `query()` double that records each turn's options and opening prompt text. */
function fakeQuery(captured: Captured[]): typeof query {
  return ((args: QueryArgs) => {
    async function* run() {
      const it = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      const first = await it.next();
      const content = first.value?.message?.content;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      captured.push({ options: args.options ?? {}, firstPrompt: text });
      yield { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "ok" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return run();
  }) as unknown as typeof query;
}

async function drain(provider: ClaudeAgentProvider, threadId: string, text: string): Promise<TurnStreamEvent[]> {
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(threadId, { text } as TurnInput)) events.push(ev);
  return events;
}

async function setup(workspace: boolean, settings = SETTINGS) {
  const captured: Captured[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/agent", baseInstructions: "base", developerInstructions: "dev" } as StartThreadInput);
  if (workspace) await provider.configureWorkspace(thread.id, settings);
  return { provider, thread, captured };
}

const BASE_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"];

test("a workspace turn runs in the root with file tools and a hard sandbox; a plain turn is unchanged", async () => {
  const plain = await setup(false);
  await drain(plain.provider, plain.thread.id, "q");
  const a = plain.captured[0]!.options;
  assert.equal(a.cwd, "/agent");
  assert.deepEqual(a.tools, BASE_TOOLS);
  assert.equal("sandbox" in a, false);

  const { provider, thread, captured } = await setup(true);
  await drain(provider, thread.id, "q");
  const o = captured[0]!.options;
  assert.equal(o.cwd, ROOT);
  assert.deepEqual(o.tools, [...BASE_TOOLS, "Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.plugins, []);
  assert.deepEqual(o.settings, { autoMemoryEnabled: false });
  assert.equal(o.sandbox?.enabled, true);
  assert.equal(o.sandbox?.failIfUnavailable, true);
  assert.equal(o.sandbox?.autoAllowBashIfSandboxed, false);
  assert.equal(o.sandbox?.allowUnsandboxedCommands, false);
  assert.deepEqual(o.sandbox?.network, { allowedDomains: [], deniedDomains: ["*"] }, "no network by default");
  assert.deepEqual(o.sandbox?.filesystem?.allowWrite, [ROOT, "/srv/u/cache"]);
  assert.deepEqual(o.sandbox?.filesystem?.denyWrite, [`${ROOT}/.git`], "the shell can't repoint the root's .git");
  assert.equal(o.env?.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(o.env?.GIT_CONFIG_VALUE_0, "", "the shell's git asks no credential helper");
  assert.equal(o.env?.UV_CACHE_DIR, "/srv/u/cache/uv");
  assert.equal(o.permissionMode, "default");
  assert.equal(a.permissionMode, "default");
  const denied = o.sandbox?.filesystem?.denyRead ?? [];
  for (const want of ["/.ssh", "/.aws", "/.config/gh", "/.netrc", "/.codex", "/.claude", "/srv/u/data", `${ROOT}/.env`, `${ROOT}/.env.*`]) {
    assert.ok(denied.some((p) => p.endsWith(want)), `denyRead covers ${want}`);
  }
  const prompt = o.systemPrompt as { prompt: string };
  assert.ok(prompt.prompt.startsWith("base\n\ndev\n\nWORKSPACE STEERING"), "the new system prompt is adopted");
});

test("a workspace with the network opened still blocks this machine, and one without a shell has no Bash", async () => {
  const net = await setup(true, { ...SETTINGS, network: true });
  await drain(net.provider, net.thread.id, "q");
  const n = net.captured[0]!.options;
  assert.deepEqual(n.sandbox?.network?.allowedDomains, ["*"]);
  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    assert.ok(n.sandbox?.network?.deniedDomains?.includes(host), `the shell can't reach ${host}`);
  }

  const webCaptured: Captured[] = [];
  const webProvider = new ClaudeAgentProvider({ queryFn: fakeQuery(webCaptured) });
  const webThread = await webProvider.startThread({ cwd: "/agent", webSearch: true } as StartThreadInput);
  await webProvider.configureWorkspace(webThread.id, SETTINGS);
  await drain(webProvider, webThread.id, "q");
  assert.deepEqual(webCaptured[0]!.options.tools, [...BASE_TOOLS, "Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"], "a web thread keeps the web in its workspace");

  const noShell = await setup(true, { ...SETTINGS, shell: false });
  await drain(noShell.provider, noShell.thread.id, "q");
  assert.deepEqual(noShell.captured[0]!.options.tools, [...BASE_TOOLS, "Read", "Write", "Edit", "Glob", "Grep"]);
  assert.equal(noShell.captured[0]!.options.sandbox?.enabled, false, "no shell, so no sandbox to require");
});

test("a protected folder that holds the root is denied around it, not over it", async () => {
  const { provider, thread, captured } = await setup(true, { ...SETTINGS, protectedPaths: ["/srv/u/work"] });
  await drain(provider, thread.id, "q");
  const denied = captured[0]!.options.sandbox?.filesystem?.denyRead ?? [];
  assert.equal(denied.includes("/srv/u/work"), false, "the root stays readable");
  assert.equal(denied.includes(ROOT), false);
});

test("a workspace turn's CLI keeps its login and the system basics, and none of the host's other secrets", () => {
  const env = workspaceEnv("/c", {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LC_ALL: "en_GB.UTF-8",
    HTTPS_PROXY: "http://proxy:3128",
    ANTHROPIC_API_KEY: "sk-ant",
    CLAUDE_CONFIG_DIR: "/srv/u/.claude",
    GOOGLE_OAUTH_CLIENT_SECRET: "s1",
    APP_SHARED_TOKEN: "s2",
    DATABASE_PASSWORD: "s3",
    GH_TOKEN: "s4",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  });
  for (const name of ["PATH", "HOME", "LC_ALL", "HTTPS_PROXY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]) {
    assert.ok(name in env, `keeps ${name}`);
  }
  for (const name of ["GOOGLE_OAUTH_CLIENT_SECRET", "APP_SHARED_TOKEN", "DATABASE_PASSWORD", "GH_TOKEN", "SSH_AUTH_SOCK"]) {
    assert.equal(name in env, false, `drops ${name}`);
  }
  assert.equal(env.UV_CACHE_DIR, "/c/uv");
  assert.equal("UV_CACHE_DIR" in workspaceEnv(undefined, {}), false, "no cache folder, no cache vars");
});

test("the workspace steering rides once on the first workspace turn's message", async () => {
  const { provider, thread, captured } = await setup(true);
  await drain(provider, thread.id, "first");
  await drain(provider, thread.id, "second");
  assert.ok(captured[0]!.firstPrompt.includes("WORKSPACE STEERING"));
  assert.ok(captured[0]!.firstPrompt.includes("first"));
  assert.equal(captured[1]!.firstPrompt.includes("WORKSPACE STEERING"), false);
});

test("a turn already running when workspace mode switches on leaves the steering for the next turn", async () => {
  const captured: Captured[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const base = fakeQuery(captured);
  let calls = 0;
  const queryFn = ((args: QueryArgs) => {
    const inner = base(args) as AsyncIterable<unknown>;
    const gated = calls++ === 0;
    return (async function* () {
      for await (const msg of inner) {
        if (gated && (msg as { type: string }).type === "result") await held;
        yield msg;
      }
    })();
  }) as unknown as typeof query;
  const provider = new ClaudeAgentProvider({ queryFn });
  const thread = await provider.startThread({ cwd: "/agent", baseInstructions: "base", developerInstructions: "dev" } as StartThreadInput);
  const running = drain(provider, thread.id, "first");
  while (captured.length === 0) await new Promise((r) => setImmediate(r));
  await provider.configureWorkspace(thread.id, SETTINGS);
  release();
  await running;
  await drain(provider, thread.id, "next");
  assert.equal(captured[0]!.firstPrompt.includes("WORKSPACE STEERING"), false);
  assert.ok(captured[1]!.firstPrompt.includes("WORKSPACE STEERING"), "the first turn that sent it consumes it");
});

/** Run one workspace turn, then call its `canUseTool` and return the approval
 *  id it parked (undefined when the call was decided outright). */
async function permission(tool: string, input: Record<string, unknown>, settings = SETTINGS) {
  const { provider, thread, captured } = await setup(true, settings);
  await drain(provider, thread.id, "q");
  const canUseTool = captured[0]!.options.canUseTool as CanUseTool;
  const opts = { toolUseID: "call1", signal: new AbortController().signal } as Parameters<CanUseTool>[2];
  const result = canUseTool(tool, input, opts);
  const [approvalId] = (provider as unknown as { pending: Map<string, unknown> }).pending.keys();
  return { provider, result, approvalId };
}

test("every native tool call parks for the host, reads inside the root included, and a decline's reason reaches the model", async () => {
  const cases: Array<{ name: string; tool: string; input: Record<string, unknown> }> = [
    { name: "Bash", tool: "Bash", input: { command: "git push", description: "push" } },
    { name: "Edit", tool: "Edit", input: { file_path: `${ROOT}/a.py`, old_string: "a", new_string: "b" } },
    { name: "Read outside the root", tool: "Read", input: { file_path: "/srv/u/.ssh/id_ed25519" } },
    { name: "Read of an env file", tool: "Read", input: { file_path: `${ROOT}/.env` } },
    { name: "Read inside the root", tool: "Read", input: { file_path: `${ROOT}/README.md` } },
    { name: "Grep without a path", tool: "Grep", input: { pattern: "x" } },
  ];
  for (const c of cases) {
    const { provider, result, approvalId } = await permission(c.tool, c.input);
    assert.ok(approvalId, c.name);
    await provider.resolveApproval(approvalId, { action: "decline", reason: "The host commits for you." });
    const denied = await result;
    assert.equal(denied?.behavior, "deny", c.name);
    assert.equal(denied?.behavior === "deny" ? denied.message : "", "The host commits for you.", c.name);
  }
  const { provider, result, approvalId } = await permission("Read", { file_path: `${ROOT}/README.md` });
  await provider.resolveApproval(approvalId!, { action: "accept" });
  assert.equal((await result)?.behavior, "allow");
});

test("a refused native call is denied outright, without reaching the host", async () => {
  const { result, approvalId } = await permission(
    "Bash",
    { command: "git push origin HEAD" },
    { ...SETTINGS, refusal: (req) => ((req.detail as { command?: string }).command?.startsWith("git push") ? "Pushes are the host's job." : null) },
  );
  assert.equal(approvalId, undefined);
  const denied = await result;
  assert.equal(denied?.behavior, "deny");
  assert.equal(denied?.behavior === "deny" ? denied.message : "", "Pushes are the host's job.");
});

test("the parked approval carries the documented detail shapes", async () => {
  const shapes: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      "Bash",
      { command: "uv run pytest", description: "run tests" },
      "command",
      { command: "uv run pytest", cwd: ROOT, reason: "run tests", _meta: { native_tool: "Bash" } },
    ],
    [
      "Write",
      { file_path: "new/file.txt", content: "hello" },
      "fileChange",
      { changes: [{ path: `${ROOT}/new/file.txt`, kind: "add" }], _meta: { native_tool: "Write" } },
    ],
    [
      "Glob",
      { pattern: "*.py", path: "/etc" },
      "command",
      { command: "Glob /etc", cwd: ROOT, _meta: { native_tool: "Glob", path: "/etc", pattern: "*.py" } },
    ],
  ];
  for (const [tool, input, kind, detail] of shapes) {
    const events: TurnStreamEvent[] = [];
    // A query that asks permission mid-turn, so the event lands on the stream.
    const asking = new ClaudeAgentProvider({
      queryFn: ((args: QueryArgs) => {
        async function* run() {
          const decision = args.options!.canUseTool!(tool, input, {
            toolUseID: "call1",
            signal: new AbortController().signal,
          } as Parameters<CanUseTool>[2]);
          yield { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "asking" }] } };
          await decision;
          yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
        }
        return run();
      }) as unknown as typeof query,
    });
    const t = await asking.startThread({ cwd: "/agent" } as StartThreadInput);
    await asking.configureWorkspace(t.id, SETTINGS);
    for await (const ev of asking.sendTurn(t.id, { text: "q" } as TurnInput)) {
      events.push(ev);
      if (ev.type === "approval.requested") await asking.resolveApproval(ev.request.requestId, { action: "accept" });
    }
    const req = events.find((e) => e.type === "approval.requested");
    assert.ok(req && req.type === "approval.requested", tool);
    assert.equal(req.request.kind, kind, tool);
    const { toolUseId, ...rest } = req.request.detail as Record<string, unknown>;
    assert.equal(toolUseId, "call1");
    assert.deepEqual(rest, detail, tool);
  }
});

test("the PreToolUse hook holds the hard refusals and hands every other call to the host", async () => {
  type PreToolUse = (input: unknown) => Promise<{ continue?: boolean; hookSpecificOutput?: { permissionDecision?: string } }>;
  const captured: Captured[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/agent" } as StartThreadInput);
  await provider.configureWorkspace(thread.id, {
    ...SETTINGS,
    refusal: (req) => ((req.detail as { command?: string }).command?.startsWith("git push") ? "Pushes are the host's job." : null),
  });
  await drain(provider, thread.id, "q");
  const o = captured[0]!.options;
  const hook = o.hooks?.PreToolUse?.[0]?.hooks[0] as unknown as PreToolUse;
  const decide = async (tool_name: string, tool_input: Record<string, unknown>) =>
    (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "c1" })).hookSpecificOutput?.permissionDecision ?? "pass";
  assert.equal(await decide("Bash", { command: "git push origin HEAD" }), "deny");
  assert.equal(await decide("Bash", { command: "uv sync" }), "ask");
  assert.equal(await decide("mcp__lab__echo", { text: "hi" }), "ask");
  assert.equal(await decide("TaskList", {}), "pass", "plan tools are never gated");
  assert.equal(await decide("StructuredOutput", { findings: [] }), "pass", "the turn's answer is never gated");
  assert.equal(await decide("WebFetch", { url: "https://example.com" }), "pass", "web tools touch no files");
});
