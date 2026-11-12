/**
 * The dedicated CODEX_HOME the Codex provider runs under. Codex reads its
 * config, skills, project docs and MCP servers from `$CODEX_HOME`, so pointing
 * it at the user's own `~/.codex` would hand the agent everything configured
 * there. The provider instead prepares a home of its own on every start:
 *
 *   - `config.toml` is rewritten from scratch, carrying only what an isolated
 *     agent needs (project docs off, no plugins, apps, skills, shell or image viewer, Codex's
 *     native plan tool on) and nothing from `~/.codex`. MCP servers are not in
 *     it at all: each thread passes its own (see `thread-config.ts`).
 *   - `auth.json` is a symlink to `~/.codex/auth.json`, so the user's login is
 *     reused without a separate `codex login` (and token refreshes stay shared).
 *   - Codex's bundled `.system` skills are kept from repopulating.
 *   - With a subagent role, `agents/<role>.toml` defines it.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SubagentRole } from "../subagents.ts";

/**
 * The managed `config.toml`: deliberately minimal. Unknown keys are ignored by
 * an older codex, but a TYPE mismatch on a known key makes codex discard the
 * whole file (and run on defaults), so every value here is the type codex 0.147+
 * expects.
 */
export function managedCodexConfig(): string {
  return [
    "# Managed by muxi-agent: rewritten every time the provider starts. Do not edit.",
    "# Isolates the agent from the user's own ~/.codex (plugins, skills, project",
    "# docs, MCP servers, trust rules). Threads bring their own MCP servers.",
    "",
    "# Never inject AGENTS.md or other project docs into the agent's context.",
    "project_doc_max_bytes = 0",
    "# Codex loads repo-scope skills from every .codex/skills between the project",
    "# root (default marker: .git) and the thread cwd. With no markers only the",
    "# cwd itself is scanned.",
    "project_root_markers = []",
    "# Off unless a thread starts with web search.",
    'web_search = "disabled"',
    "# No shell, so no sandbox prose to explain; no apps either.",
    "include_permissions_instructions = false",
    "include_apps_instructions = false",
    "",
    "[features]",
    "goals = false",
    "plugins = false",
    "shell_tool = false",
    "image_generation = false",
    "# Codex's own tool for reading an image off the disk: a thread's tools come",
    "# from its MCP servers only.",
    "view_image = false",
    "apps = false",
    "# Multi-agent is off for every thread; a subagent thread turns it on for",
    "# itself (codex/subagents.ts).",
    "multi_agent_v2 = false",
    "",
    "# The other half of the multi-agent switch: `features.multi_agent_v2 = false`",
    "# alone leaves it on for catalog models.",
    "[agents]",
    "enabled = false",
    "",
    "# Codex renders a <skills_instructions> block from its built-in catalog even",
    "# when no skill files are on disk.",
    "[skills]",
    "include_instructions = false",
    "",
    "# Codex's native plan tool; its `turn/plan/updated` notifications become",
    "# `agent.plan.updated`. A struct, not a bool.",
    "[tools.update_plan]",
    "enabled = true",
    "",
  ].join("\n");
}

/** The role Codex runs a subagent under (`spawn_agent` with `agent_type:
 *  "<role>"`). A role can't narrow a thread's MCP servers, so a host's policy
 *  refuses a subagent's writes; it can turn multi-agent off, so a subagent
 *  starts no subagents of its own, and web search off. */
export function codexSubagentRole(role: SubagentRole): string {
  return [
    "# Managed by muxi-agent: rewritten every time the provider starts. Do not edit.",
    `name = ${JSON.stringify(role.role)}`,
    `description = ${JSON.stringify(role.description)}`,
    `developer_instructions = ${JSON.stringify(role.instructions)}`,
    'web_search = "disabled"',
    "",
    "[features]",
    "multi_agent_v2 = false",
    "",
  ].join("\n");
}

export interface PrepareCodexHomeOptions {
  /** The dedicated home. Must not be the user's own `~/.codex`. */
  codexHome: string;
  /** The user's own Codex home, whose `auth.json` is linked in. Default
   *  `~/.codex`. */
  userCodexHome?: string;
  subagent?: SubagentRole;
}

/**
 * Prepare the dedicated home (see the module header). Returns whether auth is
 * in place afterwards: false means the user has no Codex login to share, and
 * turns will fail as not logged in until they sign in.
 */
export function prepareCodexHome(opts: PrepareCodexHomeOptions): boolean {
  const userHome = opts.userCodexHome ?? join(homedir(), ".codex");
  if (samePath(opts.codexHome, userHome)) {
    throw new Error(`codexHome must be a dedicated folder, not the user's own Codex home (${userHome})`);
  }
  mkdirSync(opts.codexHome, { recursive: true });
  writeFileSync(join(opts.codexHome, "config.toml"), managedCodexConfig(), "utf-8");
  const agents = join(opts.codexHome, "agents");
  rmSync(agents, { recursive: true, force: true });
  if (opts.subagent) {
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${opts.subagent.role}.toml`), codexSubagentRole(opts.subagent), "utf-8");
  }
  suppressBundledSystemSkills(opts.codexHome, userHome);
  return ensureCodexAuthLink(opts.codexHome, userHome);
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Keep Codex's bundled `.system` skills out of the dedicated home. Codex
 * repopulates `$CODEX_HOME/skills/.system/` on every boot UNLESS a
 * `.codex-system-skills.marker` matching the binary's bundled-skills hash is
 * present. The folder is reset to hold only a marker: the one Codex last wrote
 * in this home (always matches its binary), else the user's own copy. With
 * neither, Codex repopulates once and writes a fresh marker that is kept from
 * then on.
 */
function suppressBundledSystemSkills(codexHome: string, userHome: string): void {
  const sysDir = join(codexHome, "skills", ".system");
  const markerName = ".codex-system-skills.marker";
  const destMarker = join(sysDir, markerName);
  const srcMarker = join(userHome, "skills", ".system", markerName);
  try {
    const keep = existsSync(destMarker) ? readFileSync(destMarker) : null;
    rmSync(sysDir, { recursive: true, force: true });
    mkdirSync(sysDir, { recursive: true });
    if (keep !== null) {
      writeFileSync(destMarker, keep);
      return;
    }
    if (existsSync(srcMarker)) copyFileSync(srcMarker, destMarker);
  } catch (err) {
    console.warn(`[muxi-agent:codex] could not suppress Codex's bundled skills: ${String(err)}`);
  }
}

/**
 * Link the user's `auth.json` into the dedicated home. A live file or symlink
 * already there (a login made in this home) is kept; a dangling symlink is
 * replaced. Returns whether auth is in place afterwards.
 */
export function ensureCodexAuthLink(codexHome: string, userHome = join(homedir(), ".codex")): boolean {
  const dest = join(codexHome, "auth.json");
  const source = join(userHome, "auth.json");
  if (existsSync(dest)) return true;
  try {
    lstatSync(dest);
    rmSync(dest);
  } catch {
    /* plain missing dest */
  }
  if (!existsSync(source)) return false;
  try {
    symlinkSync(source, dest);
    return true;
  } catch {
    return existsSync(dest);
  }
}
