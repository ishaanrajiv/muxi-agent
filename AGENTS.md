# Muxi Agent: notes for coding agents

`CLAUDE.md` is a symlink to this file. README.md is the user-facing contract:
read it before changing behaviour, and update it in the same change when what
it promises moves.

## This is a public repository

Everything here is public: code, comments, tests, fixtures, commit messages,
branch names, issues and pull request descriptions. Treat anything that isn't
already public as private, and keep it out:

- host names, IP addresses, ports of real machines, and personal paths
  (`/home/<name>`, `/Users/<name>`);
- email addresses, names, account or organization ids;
- private project, service, product or company names, and internal plans or
  roadmaps (why a change is wanted by some app the library serves);
- tokens, keys, cookies, OAuth codes, and real account data (plans, usage
  figures, model access);
- transcripts, logs or wire captures from a real account.

Use synthetic examples only: `/home/u`, `/w/root`, `127.0.0.1:8787`,
`user@example.com`, made-up thread and turn ids. Describe behaviour in library
terms: "the host", "a caller", "a consumer", never a particular app's screens.
Before you push, review the diff and the commit message for anything that
breaks this, and run gitleaks (`gitleaks dir .` and `gitleaks git .`). A
secret that reached a public commit is burned: rotate it, don't just delete it.

## What it is

One TypeScript interface, `AgentProvider` (`src/provider.ts`), over two coding
agent backends that run with the user's own logins:

- **Claude**, through `@anthropic-ai/claude-agent-sdk` (`query()` and the
  bundled `claude` CLI): `ClaudeAgentProvider`.
- **Codex**, through `codex app-server` over JSON-RPC on stdio:
  `CodexAgentProvider`.

Both produce the same `TurnStreamEvent`s, approvals and usage objects. The
library also enforces isolation (no user settings, skills, plugins or memory;
only the MCP servers a thread is given) and, in workspace mode, a filesystem
and network sandbox. Those boundaries are security-relevant: see SECURITY.md.

## Layout

- `src/index.ts`: the main entry point. `src/types/index.ts`: the `/types`
  entry point, zod schemas and types only, no runtime dependency beyond zod.
- `src/provider.ts`: the `AgentProvider` interface and its inputs.
- `src/types/`: the wire vocabulary (events, approvals, provider inputs and
  status, subagents, web search, work summaries) as zod schemas plus inferred types.
- `src/claude-provider.ts` and `src/claude/`: the Claude backend (SDK options
  and isolation, event mapping, permissions and the guard's hooks, plan,
  subagents, workspace sandbox, usage, catalog, auth, credential redaction,
  transcript cuts for rollback and fork).
- `src/codex-provider.ts`, `src/codex-client.ts` and `src/codex/`: the Codex
  backend (the JSON-RPC client, the dedicated `CODEX_HOME`, thread config,
  turns, models, subagents, workspace profile, compaction, the timeout clock).
  `src/normalize.ts` is the only place that reads Codex's notification and
  request shapes. `src/codex-account.ts`, `src/codex-usage.ts`, `src/probe.ts`:
  login, usage windows, the environment probe.
- Shared by both: `src/shared.ts`, `src/subagents.ts`, `src/web-search.ts`,
  `src/workspace-sandbox.ts`, `src/model-defaults.ts`, `src/usage-limit.ts`.
- `src/generated/`: Codex protocol bindings, generated (see below). Never edit by hand.
- `src/testing/`: test helpers, excluded from the build.
- `fixtures/codex-<version>/`: recorded app-server sessions (`*.ndjson`) and
  their golden event sequences (`*.golden.json`) for `src/codex-replay.test.ts`.
- `scripts/`: the build, the Codex fixture recorder and scrubber, the version
  recorder, and the live checks (`smoke.ts`, `live-auto-mode.ts`) with their
  throwaway MCP server (`scripts/lib/echo-mcp-server.ts`).
- `third_party/codex/`: the Apache-2.0 LICENSE and NOTICE for `src/generated/`.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint     # tsc --noEmit over src/ and scripts/
pnpm test     # node --test over src/**/*.test.ts, no build step
pnpm build    # dist/ via tsconfig.build.json (also run by `prepare`)
```

Run `pnpm lint` and `pnpm test` before every commit; CI runs both on Node 24
and 26. The unit tests need no CLI, login or network: Claude is driven through
the `queryFn` seam, Codex through a fake app-server and the replay fixtures.
Keep it that way.

`pnpm smoke` and `pnpm live:auto` use the real logged-in CLIs and spend a little
quota. They are for a person to run on their own machine (before an SDK or CLI
bump, for example), never in CI, and their output (`.smoke/`) is never committed.

## Conventions

- ESM only (`"type": "module"`), Node >= 24. Sources run directly under Node's
  type stripping, so relative imports name the `.ts` file; tsc rewrites them to
  `.js` on emit. Use only erasable TypeScript syntax (no enums, namespaces or
  parameter properties).
- Strict TypeScript with `noUnusedLocals`.
- Public data shapes are zod 4 schemas in `src/types/`, with the TypeScript
  type inferred from the schema. Add a field to the schema, not just the type.
- Dependencies are pinned to exact versions. Add one only when it's needed; the
  `/types` entry point must stay zod-only.
- Tests sit beside the code as `*.test.ts` and use `node:test` and `node:assert`.
- Comments explain why, in library terms, and say what a value means to a caller.
- Never let a backend read the user's own agent config: Claude sessions keep
  `settingSources: []` and a fixed tool list; Codex runs under the dedicated
  home `src/codex/home.ts` writes. Changes there need a test.

## Codex bindings, fixtures and the NOTICE

The bindings in `src/generated/` come from the Codex CLI and are recorded in
`package.json` (`codexBindings.codexCli`). To move to a new CLI:

1. `pnpm generate` (regenerates `src/generated/` and records the version), then
   `pnpm lint` and fix what the new protocol broke.
2. Record fixtures for that version with `node scripts/record-codex-fixtures.ts`
   (a logged-in `codex` is needed; it runs under a scratch `CODEX_HOME` against
   the local echo server), then `UPDATE_GOLDENS=1 node --test src/codex-replay.test.ts`
   and `pnpm test`.
3. Update `third_party/codex/NOTICE`: the upstream NOTICE link names the CLI's
   tag (`rust-v<version>`), and its text must match that tag's NOTICE. Keep the
   "Changes" paragraph true if the build's handling of `dist/generated/` changes.

Fixtures come only from `scripts/record-codex-fixtures.ts`, which redacts
emails, keys, the host name, paths and ports, and then runs the scrubber
(`scripts/lib/fixture-scrub.ts`: shifted timestamps, synthetic ids, no plan or
usage figures). Never hand-write a fixture from a real session or paste wire
logs in. If you add a scrub rule, re-scrub the existing fixtures with
`node scripts/scrub-fixtures.ts` and extend `src/fixture-scrub.test.ts`. Read
every new fixture and golden diff for anything private before committing it.
