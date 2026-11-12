# Muxi Agent

Claude and Codex coding agents behind one TypeScript interface.

`@ishaanrajiv/muxi-agent` drives the Claude Agent SDK (the `claude` CLI) and the
Codex app-server (`codex app-server`) with the user's own logins on the
machine. Both backends come out as the same `AgentProvider`: threads, turns
that stream one event vocabulary, approvals the host answers, usage windows and
model catalogs. Each thread sees only the MCP servers you hand it, and neither
backend reads the user's own agent settings, memory, skills or plugins.

- ESM only, Node >= 24, TypeScript types included, zod 4 schemas for the wire types.
- Two entry points: `@ishaanrajiv/muxi-agent` (providers, helpers and the types)
  and `@ishaanrajiv/muxi-agent/types` (schemas and types alone, with no runtime
  dependency beyond zod).

## Install

The package is not on a registry. Depend on a commit:

```json
{
  "dependencies": {
    "@ishaanrajiv/muxi-agent": "git+https://github.com/ishaanrajiv/muxi-agent.git#<commit-sha>"
  }
}
```

The `prepare` script compiles `dist/` on install. npm runs it as is. pnpm 10
refuses to prepare a git dependency until it is allowed by its full spec in
`pnpm-workspace.yaml`. Use the `git+https` form above in both places: pnpm
doesn't accept a `github:` shorthand in `onlyBuiltDependencies`.

```yaml
onlyBuiltDependencies:
  - "@ishaanrajiv/muxi-agent@git+https://github.com/ishaanrajiv/muxi-agent.git#<commit-sha>"
```

The built declarations type-check under `moduleResolution` `nodenext` and `bundler` alike.

Runtime requirements on the machine:

- `claude` comes with the SDK's bundled CLI. Log in once with `claude login`, or set
  `ANTHROPIC_API_KEY`.
- `codex` must be on `PATH` (or passed as `codexBin`), logged in with `codex login`.
  The bindings in `src/generated/` match the version in `package.json`
  (`codexBindings.codexCli`); a newer CLI usually works, and the replay tests say
  where it doesn't.

## Quick start

```ts
import { ClaudeAgentProvider, CodexAgentProvider, type AgentProvider } from "@ishaanrajiv/muxi-agent";

const claude = new ClaudeAgentProvider();
const codex = new CodexAgentProvider({ codexHome: "/var/lib/myapp/codex-home" });

async function ask(provider: AgentProvider) {
  const thread = await provider.startThread({
    cwd: "/var/lib/myapp/scratch",
    model: provider.id === "claude" ? "claude-haiku-5-5" : "gpt-6-luna",
    baseInstructions: "You are a terse assistant.",
    mcpServers: { notes: { type: "http", url: "http://127.0.0.1:8787/mcp" } },
  });
  for await (const ev of provider.sendTurn(thread.id, { text: "Summarize my notes." })) {
    if (ev.type === "approval.requested") {
      await provider.resolveApproval(ev.request.requestId, { action: "accept" });
    }
    if (ev.type === "agent.message.completed") console.log(ev.text);
  }
}
```

## The interface

```ts
interface AgentProvider {
  readonly id: "claude" | "codex";

  probe(): Promise<ProviderStatus>;             // binary, version, login
  listModels(): Promise<AgentModel[]>;          // the live, login-dependent catalog
  getUsage(): Promise<ProviderUsage | null>;    // subscription windows; costs no quota
  runUtilityTurn(input: UtilityTurnInput): Promise<UtilityTurnResult>; // schema output, no tools, not persisted

  startThread(input: StartThreadInput): Promise<Thread>;
  resumeThread(threadId: string, state?: ResumeThreadState): Promise<Thread>;
  sendTurn(threadId: string, input: TurnInput): AsyncIterable<TurnStreamEvent>;
  resolveApproval(requestId: string | number, decision: ApprovalDecision): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  releaseThread(threadId: string): Promise<void>;
  configureWorkspace(threadId: string, settings: WorkspaceSettings): Promise<void>;

  rollbackThread(threadId: string, numTurns: number, opts?): Promise<RollbackResult>;
  forkThread(threadId: string, opts?: HistoryCut): Promise<Thread>;
  supportsSteer?: boolean;
  steerTurn?(threadId: string, turnId: string, text: string, steerId?: string): Promise<void>;
  stopSubagent?(threadId: string, subagentId: string): Promise<boolean>;
}
```

### Starting a thread

```ts
interface StartThreadInput {
  cwd: string;
  model?: string;
  effort?: string;                    // clamped to the model's own scale
  baseInstructions?: string;
  developerInstructions?: string;
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  webSearch?: boolean;                // Claude: WebSearch + WebFetch. Codex: live web search.
  subagents?: boolean;                // needs the provider's `subagent` role option
  askUser?: boolean;                  // Claude: AskUserQuestion (questions as approvals, below)
  approvalMode?: "ask" | "auto" | "full"; // recorded for the host; providers don't act on it
}
```

- **`mcpServers`** are the only MCP servers the thread sees. They are streamable
  HTTP only. A server's name becomes part of its tool names (`mcp__<name>__<tool>`
  on Claude), so names are limited to letters, digits, `-` and `_`. Every tool call
  on either backend reaches the host as an `approval.requested`.
- **`webSearch`**, **`subagents`** and **`askUser`** are fixed per thread. To change them, call
  `resumeThread(id, { webSearch, subagents, askUser })`; Codex then reloads the thread with
  the new config.
- **Subagents** need a role on the provider (`subagent: { role, description,
  instructions, refusedTools? }`). Claude registers it as an `Agent` subagent type,
  and Codex as an agent role in its home. Each turn allows at most 3 live and 6 total.
  A subagent never gets web search or the plan tools. `refusedTools` lists MCP
  tools (`{ server, tool? }`) it may not call.

### Sending a turn

```ts
interface TurnInput {
  text: string;
  images?: { dataUrl: string; name?: string }[];
  documents?: { name: string; mediaType: "application/pdf" | "text/plain"; data: string }[];
  model?: string;                      // sticky: later turns keep it
  effort?: string;                     // sticky
  serviceTier?: string | null;         // Codex only
  trigger?: { kind: string; [k: string]: unknown }; // a turn the system started, echoed on turn.started
  outputSchema?: Record<string, unknown>;           // JSON schema for the final answer
  permissionMode?: "default" | "auto";              // Claude only, per turn (below)
  mcpServers?: Record<string, McpServerConfig>;     // Claude only, this turn only (below)
}
```

`documents` carries a PDF as base64 or a text file as its text. Claude reads
both as `document` blocks ahead of the text. Codex has no document input: text
files ride inline in the message as `<document name="…">…</document>`, and a
PDF becomes a note that the model can't read it. `turn.started` names the
documents but leaves their contents out.

With `outputSchema`, the turn's last `agent.message.completed` is JSON matching
the schema. Claude uses the SDK's `outputFormat`; Codex uses `outputSchema` on
`turn/start`.

### Persisting and resuming

A host that restarts calls `resumeThread(threadId, state)` with what it saved:
`ResumeThreadState` holds `providerSessionId` (Claude's session after a rollback
or fork), `systemPrompt` (use `composeSystemPrompt(base, developer)`), `effort`,
`cwd`, `model`, `mcpServers`, `webSearch`, `subagents` and `askUser`. Codex keeps its own
rollout under its `CODEX_HOME`. Claude resumes its session transcript.

## Events

`sendTurn` yields `TurnStreamEvent`s, a union discriminated on `type`:

| Event | Meaning |
| --- | --- |
| `thread.started` | A thread the backend created (Codex). |
| `turn.started` | The turn began: `provider`, `prompt`, `model`, `effort`, `trigger`. |
| `agent.message.delta` / `agent.message.completed` | The answer, streamed and final. |
| `agent.reasoning.delta` / `agent.reasoning.completed` | Reasoning summaries. |
| `agent.plan.updated` | The whole plan (Claude's task tools, Codex's `update_plan`). |
| `agent.subagent.updated` | A subagent's state, brief, calls and report. |
| `tool.started` / `tool.progress` / `tool.completed` | A tool call, with `server` and `tool`. The `builtin` server's `webSearch` covers both backends' search. |
| `tool.input.delta` | Transient input for tools named in Claude's `streamedInputTools`. |
| `approval.requested` | Something for the host to decide (below). |
| `context.usage` | Context window occupancy. |
| `context.compaction` | A compaction started or completed, with sizes before and after. |
| `turn.steer.read` | A steer the model has read. |
| `prompts.returned` | Steers the turn never took, handed back. |
| `error.raised` | `code` (see below), `message` and `fatal`. A non-fatal error is a warning. |
| `turn.completed` | The turn ended. Exactly one terminal event: this, or a fatal `error.raised`. |

Error codes (`ERROR_CODES`): `binary_missing`, `not_logged_in`, `network`,
`timeout`, `mcp_unavailable`, `cli_outdated`, `config_invalid`, `usage_limit`,
`overloaded`, `context_full`, `model_rerouted`, `deprecated`, `turn_failed`,
`interrupted` and `unknown`.

### Approvals

`approval.requested.request` is `{ requestId, kind, threadId, turnId, summary,
detail, subagent? }`. `kind` is one of `command`, `fileChange`, `mcpElicitation`,
`permissions` or `userInput`. Answer it with `resolveApproval(requestId, decision)`,
where `decision.action` is one of `accept`, `approve_for_session`, `decline`,
`cancel` or `abort`. A decline's `reason` reaches the model as the tool's result.

- **MCP tool calls**: `mcpToolCallOf(request)` returns `{ server, tool }`, and
  `toolArgsOf(request)` returns the call's arguments, on both backends.
- **The model's questions**: Claude's `AskUserQuestion` (on a thread started
  with `askUser`) and Codex's `requestUserInput` arrive as `userInput`.
  `questionsOf(request)` returns `[{ id, question, header?, multiSelect, options:
  [{ label, description? }] }]` on both backends. Answer with `{ action: "accept",
  content: answersContent(request, { "<question text>": "<answer>" }) }`: a picked
  label, labels joined by ", ", or the person's own words. Claude hands the
  answers to the model in `updatedInput.answers`. A decline (or an accept with no
  answers) tells the model the person didn't answer, with the decline's `reason`
  when it has one. A subagent can't ask.
- **Questions from a tool**: an MCP tool can ask a person through MCP elicitation. Tag the
  elicit message as JSON `{"kind":"question","question":"..."}` and the summary
  reads as the question; answer it with `{ action: "accept", content }`.
- **Workspace calls**: see below.
- **The guard** (Claude): `new ClaudeAgentProvider({ guard })` takes a
  `ToolGuard`, `({ threadId, tool, input, agentId? }) => string | null`: the
  reason a call is refused, whatever else would decide it. It runs as the first
  `PreToolUse` hook on every turn, for the main agent and subagents, so it holds
  for the calls the kit runs unasked (web search and fetch, the plan tools), and
  again in `canUseTool`. A guard that throws refuses. A turn's hooks from every
  part (the guard, the plan, a workspace, subagents) are concatenated per event;
  a deny from any of them wins. Codex has no hook: its MCP calls and workspace
  calls reach the host as approvals, and its web search is the backend's own.
- **Auto mode** (Claude, `permissionMode: "auto"` on a turn; not sticky). Claude
  Code's classifier decides calls that would otherwise reach `canUseTool`; what it
  can't decide, or escalates, still reaches `canUseTool`. The guard's hook runs
  first either way. The host doesn't see the calls the classifier allows: it
  learns of them only as `tool.started`/`tool.completed`, so it must enforce
  anything that matters where the call lands (its MCP server). A Codex turn
  asked for auto throws.
- **Per-turn MCP servers** (Claude, `mcpServers` on a turn). They replace the
  thread's for that turn only (`{}` means none) and are never stored, so the
  next turn, a resume or a fork goes back to the thread's. A host uses it to
  hand each turn its own endpoint (a nonce in the URL) and refuse stale ones,
  so a call the classifier allows still lands where the host checks the turn.
  The turn's and the thread's MCP credentials are masked in every form they're
  quoted in: the URL, its path and query, query values and path segments,
  header values, and their percent-encoded and JSON-escaped forms. That covers:
  - everything Muxi Agent logs (the CLI's stderr by whole lines, and SDK errors);
  - the diagnostic fields of events: `error.raised` `message` and `raw`,
    `tool.completed` `error` and `result`, `agent.subagent.updated.error`, and
    `context.compaction.message`;
  - a thrown turn error.

  Only string values are masked; types, ids and keys are untouched. Not masked:
  - the model's own text;
  - the SDK's own debug log (`DEBUG_CLAUDE_AGENT_SDK`), which records the spawn
    command with the whole `--mcp-config`. Don't enable it where the config
    holds credentials.

  A per-turn endpoint makes any copy that slips through worthless once its turn
  ends. A Codex turn given `mcpServers` throws.
- **Refused calls** (Claude): a call that didn't run ends as `tool.completed`
  with `status: "declined"` and `denial: { by, reason? }`. `by` is `guard` (the
  host's guard), `host` (its `canUseTool` answer), `classifier`, `rule` or
  `mode` (the CLI's), or `other`. The host's own refusals are declined as soon
  as the call's result comes back, and stay so. Any other refusal is first a
  plain `error`, and gets a second `tool.completed` once the turn's result lists
  it as refused (that list is the CLI's record; its per-call message is
  advisory, and only names who refused a call the list confirms). A listed call
  whose result never came back gets that one event. Declined is never taken
  back. A subagent's call carries the same `denial` on its `failed` entry in
  `agent.subagent.updated`, added after the subagent finished if need be.

## Isolation

Neither backend sees the user's own configuration.

**Claude** runs every session with:

- `settingSources: []`: no user, project or local settings.
- `strictMcpConfig`, and only the thread's `mcpServers`, each registered with `alwaysLoad`.
- `plugins: []`, `skills: []` and `autoMemoryEnabled: false`.
- A fixed `tools` list:
  - the plan tools and `ToolSearch` on every thread;
  - `WebSearch` and `WebFetch` only with `webSearch`;
  - the file tools and `Bash` only in workspace mode.

  Every other built-in, including `Agent` unless the thread has subagents, is unavailable.

**Codex** runs under a dedicated `CODEX_HOME` the caller passes (`codexHome`, which
must not be the user's own `~/.codex`). On every start the provider sets that home up:

- It rewrites `config.toml` with:
  - project docs off (`project_doc_max_bytes = 0`, no root markers);
  - web search off;
  - no MCP servers;
  - plugins, apps, image generation, goals, the shell tool and multi-agent all off;
  - the plan tool on.
- It links in the user's `auth.json`.
- It suppresses the bundled skills.
- It writes the subagent role, if any, as the only agent role.

Each thread then turns on, in its own config, only what it asked for.

## Workspace mode

`configureWorkspace(threadId, settings)` lets a thread work on files in one folder:

```ts
interface WorkspaceSettings {
  root: string;              // the new cwd, and the only place it writes (besides cacheDir)
  protectedPaths?: string[]; // folders the shell may not read at all
  cacheDir?: string;         // package-manager caches point here and it is writable
  network?: boolean;         // default false; this machine's own servers stay blocked on Claude
  shell?: boolean;           // Claude only, default true (Codex reads through its shell)
  developerInstructions: string; // Codex: the thread's developer instructions with the workspace steering
  systemPrompt: string;          // Claude: the whole system prompt with the workspace steering
  instructions: string;          // the steering alone, sent once on the next turn when `introduce`
  introduce: boolean;
  refusal: (request) => string | null; // hard refusals, checked before the host is asked
}
```

- **On Claude, every native call goes to the host.** Every shell command, file
  read, search and edit first goes to `refusal()`, then reaches the host as an
  `approval.requested`. There are no automatic allows.
- **On Codex, only what leaves the sandbox does.** Workspace turns run with
  `approvalPolicy: "on-request"`: a command that stays inside the sandbox (writes
  only in `root` and `cacheDir`, no network unless opened) runs without asking,
  and Codex reads and edits through that shell. File changes and escalations
  reach the host. A host that must see every call should not give Codex a
  workspace.
  - Shell commands and reads have kind `command`; edits have kind `fileChange`.
  - `detail._meta.native_tool` names the tool, and `detail._meta.path` is the
    absolute path a read targets. A Glob also carries `detail._meta.pattern`,
    which can reach outside that path (`/etc/**`, `../**`): check it too.
  - On Codex, a request `refusal()` refuses is declined without the host seeing it.
  - Known Codex gaps: `configureWorkspace` on a thread that has had no turn yet
    fails ("no rollout found"), and a `codex` binary installed under `~/.codex`
    can't re-run itself inside the workspace sandbox, which hides `~/.codex`.
- **The sandbox is required.** Claude's Bash runs in the SDK sandbox with no
  unsandboxed fallback (with `shell: false` there is no Bash, and no sandbox). Codex gets a per-thread permission profile, or the
  `workspaceWrite` sandbox on builds without profiles.
  - Writes are limited to `root` and `cacheDir`, and `root/.git` stays read-only.
  - The network is off unless `network` is set.
  - The shell's git uses no credential helper and no hooks.
- **Reads are denied** for:
  - credentials in the home folder (`.ssh`, `.aws`, `.azure`, `.kube`, `.docker`,
    `.gnupg`, `.config/gh`, `.config/gcloud`, `.netrc`);
  - both agents' own homes;
  - `.env*` files in `root`;
  - `protectedPaths`. A protected folder that holds `root` or `cacheDir` is denied
    around them, not over them.
- **Claude's env is trimmed.** Its CLI keeps only the basics (`PATH`, `HOME`, the
  locale, proxies and its own `ANTHROPIC_*` and `CLAUDE_*` variables), so the host's
  secrets never reach the shell.
- **Web search and subagents are off** while a thread is in workspace mode. On
  Codex, whose workspace is worked through a shell, a thread started with web
  search can't enter workspace mode at all: `configureWorkspace` throws, as does
  `resumeThread` with `webSearch` on a thread already in it
  (`CODEX_WEB_AND_SHELL`).

## Provider options

`new ClaudeAgentProvider(options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `defaultCwd` | `process.cwd()` | cwd for a thread resumed without one |
| `turnTimeoutMs` | 30 min | a turn that runs longer fails with `timeout` |
| `rateLimitParkMs` | 20 s | how long a turn waits on a rejected rate limit before it ends as `usage_limit` |
| `pathToClaudeCodeExecutable` | bundled CLI | a different `claude` binary |
| `steer` | `true` | mid-turn steering through `steerTurn` |
| `subagent` | none | the subagent role (`SubagentRole`) |
| `streamedInputTools` | none | tool names whose input streams as `tool.input.delta` |
| `guard` | none | the host's hard refusals for every tool call (`ToolGuard`, above) |
| `queryFn` | SDK `query` | a test seam |

`new CodexAgentProvider(options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `codexHome` | required | the dedicated `CODEX_HOME` |
| `userCodexHome` | `~/.codex` | where the login is linked from |
| `codexBin` | `codex` on PATH | the binary |
| `env` | | extra env for every codex process |
| `subagent` | none | the subagent role |
| `turnTimeoutMs` | 30 min | per-turn timeout |
| `idleSweepMs` / `idleUnloadMs` | 5 / 30 min | idle threads are unloaded from the app-server |

Call `codex.stop()` to shut the app-server down. `MUXI_AGENT_CODEX_WIRE_LOG=<file>`
logs every JSON-RPC frame, which helps when debugging.

## Development

```sh
pnpm install
pnpm lint     # tsc --noEmit
pnpm test     # node --test over src/**/*.test.ts (Node's type stripping, no build)
pnpm build    # dist/ (also run by prepare)
```

The tests need no CLI and no network. Claude is driven through the `queryFn`
seam. Codex runs against a fake app-server, and recorded app-server sessions in
`fixtures/codex-<version>/` are replayed against golden event sequences.

### Smoke test

```sh
pnpm smoke            # both providers
pnpm smoke claude     # or one
```

The smoke test uses the logged-in `claude` and `codex` on the machine and spends a
little quota. For each provider it runs:

- `probe`, `listModels` and `getUsage`;
- a utility turn with an output schema;
- a two-turn thread that calls `echo` on a throwaway local MCP server
  (`scripts/lib/echo-mcp-server.ts`), accepting each approval.

Models default to `claude-haiku-5-5` and the smallest Codex model in the catalog;
override them with `CLAUDE_SMOKE_MODEL` and `CODEX_SMOKE_MODEL`. Scratch state goes
in `.smoke/`.

### Auto mode contract test

```sh
pnpm live:auto
```

Run it before any SDK or CLI bump a host's auto mode relies on. It uses the logged-in
`claude` (a little quota) against a throwaway MCP server and asserts what a host may
rely on:
- a call the host declines was asked about, never reaches the server, and ends declined by host;
- a call the guard refuses was attempted, is neither asked about nor run, and ends declined by guard;
- an accepted call runs only after its own ask (paired by the tool-use id the CLI sends the
  server, else by the case's unique arguments, and ordered by one shared counter).

It also records what auto mode's classifier did with a benign call, an
exfiltration-shaped one and an instruction injected through a tool's result. The model
often refuses before the classifier sees anything, which is why those are recorded, not
asserted. The report goes to `.smoke/live-auto-mode.json`, with the SDK and CLI
versions. A turn that fails because auto mode isn't available shows as an error: a host
should then fail closed, not fall back.

### Upgrading Codex

The Codex protocol types in `src/generated/` are generated by the CLI:

```sh
pnpm generate   # codex app-server generate-ts --experimental --out src/generated,
                # then records the version in package.json (codexBindings.codexCli)
pnpm lint       # fix what the new protocol broke
```

Then record new replay fixtures and goldens for that version:

```sh
node scripts/record-codex-fixtures.ts           # writes fixtures/codex-<version>/*.ndjson
UPDATE_GOLDENS=1 node --test src/codex-replay.test.ts
pnpm test
```

The recorder runs each scenario against the local echo server under a scratch
`CODEX_HOME`, and redacts emails, keys, the host name, paths and ports. Review the new goldens'
diff before committing them.

## License

MIT, see [LICENSE](LICENSE), except `src/generated/`: those Codex protocol bindings
are generated by the OpenAI Codex CLI and licensed under the Apache License 2.0.
See [third_party/codex/LICENSE](third_party/codex/LICENSE) and
[third_party/codex/NOTICE](third_party/codex/NOTICE).

The runtime dependency `@anthropic-ai/claude-agent-sdk` is not MIT: it is under Anthropic's own terms.
