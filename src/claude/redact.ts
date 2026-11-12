/**
 * Keeping a turn's MCP credentials out of muxi-agent's logs and the diagnostic
 * text it hands the host.
 *
 * A host puts credentials in its MCP config: a thread token or a per-turn nonce
 * in the URL, or an auth header. The CLI may quote them when an MCP server fails.
 * What is masked:
 *
 * - everything muxi-agent logs: the CLI's stderr (by whole lines) and the SDK
 *   errors it prints;
 * - the diagnostic fields of events: `error.raised` (`message`, and the string
 *   values of `raw`), `tool.completed` (`error`, `denial.reason`, and the string
 *   values of `result`), `agent.subagent.updated` (`error`, and each call's
 *   `denial.reason`), `context.compaction.message`;
 * - a thrown turn error's message and stack.
 *
 * Structural fields (types, ids, keys) are never touched, so masking can't
 * break an event's shape however short a credential is.
 *
 * Not masked:
 * - the model's own text, which is the host's conversation;
 * - the SDK's debug log (`DEBUG_CLAUDE_AGENT_SDK`), which records the spawn
 *   command with the whole `--mcp-config` and is out of muxi-agent's reach.
 *
 * A host that rotates a per-turn endpoint makes any copy that slips through
 * worthless once the turn ends.
 */

import type { McpServerConfig } from "../types/index.ts";

const MASK = "[redacted]";
/** Past this depth a payload is replaced, not walked. */
const MAX_DEPTH = 32;

/** Upper- and lower-case percent escapes of a string. */
function encodings(s: string): string[] {
  const out: string[] = [];
  for (const e of [encodeURIComponent(s), encodeURI(s)]) out.push(e, e.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  return out;
}

/** Every form a credential may be quoted in:
 *  - the URL whole, and as a request target (path and query);
 *  - the query, and each of its values;
 *  - each path segment and the fragment, decoded;
 *  - each header value;
 *  - each of those percent-encoded (either case) and JSON-escaped. */
export function mcpSecrets(servers: Record<string, McpServerConfig> | undefined | null): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    out.add(s);
    try {
      out.add(decodeURIComponent(s));
    } catch {
      // Not valid percent-encoding: the literal form is enough.
    }
  };
  for (const s of Object.values(servers ?? {})) {
    add(s.url);
    try {
      const u = new URL(s.url);
      add(u.href);
      if (u.pathname !== "/") add(u.pathname);
      for (const seg of u.pathname.split("/")) add(seg);
      if (u.search) {
        add(u.pathname + u.search);
        add(u.search.slice(1));
        for (const v of u.searchParams.values()) add(v);
      }
      if (u.hash.length > 1) add(u.hash.slice(1));
    } catch {
      // The schema only admits URLs; nothing more to take apart.
    }
    for (const v of Object.values(s.headers ?? {})) add(v);
  }
  for (const s of [...out]) {
    for (const e of encodings(s)) out.add(e);
    out.add(JSON.stringify(s).slice(1, -1));
  }
  out.delete("");
  return [...out];
}

export class Redactor {
  private readonly secrets: string[];
  private readonly longest: number;
  private readonly log: (line: string) => void;
  private pending = "";
  /** Dropping the rest of a line that was withheld. */
  private withholding = false;

  constructor(secrets: readonly string[], log: (line: string) => void = (line) => console.warn(`[muxi-agent:claude] ${line}`)) {
    this.log = log;
    // stderr is masked a line at a time, so a credential with a newline in it (a decoded `%0A`) is
    // also masked by each of its lines. That can mask more than the credential; never less.
    const all = secrets.flatMap((s) => (s.includes("\n") ? [s, ...s.split("\n")] : [s]));
    this.secrets = [...new Set(all.filter((s) => s.length > 0))];
    this.longest = this.secrets.reduce((n, s) => Math.max(n, s.length), 0);
  }

  /** Where secrets occur in `s`: every match, overlapping ones merged, in order. */
  private spans(s: string): [number, number][] {
    const all: [number, number][] = [];
    for (const secret of this.secrets) {
      for (let i = s.indexOf(secret); i !== -1; i = s.indexOf(secret, i + 1)) all.push([i, i + secret.length]);
    }
    all.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [from, to] of all) {
      const last = merged[merged.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    return merged;
  }

  /** `s` with every occurrence of every secret masked. Matches are found in the original text
   *  and overlapping ones merged, so two secrets that overlap leave no fragment behind. */
  text(s: string): string {
    if (!this.secrets.length || !s) return s;
    let out = "";
    let at = 0;
    for (const [from, to] of this.spans(s)) {
      out += s.slice(at, from) + MASK;
      at = to;
    }
    return out + s.slice(at);
  }

  /** The string values of a JSON-shaped payload masked. Keys and every non-string value are
   *  kept, so its shape is unchanged. A subtree deeper than {@link MAX_DEPTH} becomes a marker
   *  rather than going through unmasked. */
  values<T>(v: T): T {
    if (!this.secrets.length) return v;
    const walk = (x: unknown, depth: number): unknown => {
      if (typeof x === "string") return this.text(x);
      if (x === null || typeof x !== "object") return x;
      if (depth >= MAX_DEPTH) return "[omitted: nested too deep]";
      if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, depth + 1)]));
    };
    return walk(v, 0) as T;
  }

  /** An event with its diagnostic fields masked (see the module comment); any other event as
   *  it is. */
  event<E extends { type: string }>(ev: E): E {
    if (!this.secrets.length) return ev;
    const e = ev as E & Record<string, unknown>;
    switch (ev.type) {
      case "error.raised":
        return { ...e, ...(typeof e.message === "string" ? { message: this.text(e.message) } : {}), ...("raw" in e ? { raw: this.values(e.raw) } : {}) };
      case "tool.completed":
        return {
          ...e,
          ...("error" in e ? { error: this.values(e.error) } : {}),
          ...("result" in e ? { result: this.values(e.result) } : {}),
          ...(e.denial ? { denial: this.denial(e.denial) } : {}),
        };
      case "agent.subagent.updated":
        return {
          ...e,
          ...(typeof e.error === "string" ? { error: this.text(e.error) } : {}),
          ...(Array.isArray(e.calls) ? { calls: e.calls.map((c: unknown) => (c && typeof c === "object" && "denial" in c ? { ...c, denial: this.denial((c as { denial: unknown }).denial) } : c)) } : {}),
        };
      case "context.compaction":
        return typeof e.message === "string" ? { ...e, message: this.text(e.message) } : ev;
      default:
        return ev;
    }
  }

  /** A refusal with its reason masked (the CLI's reason may quote an endpoint). */
  private denial(d: unknown): unknown {
    if (!d || typeof d !== "object") return d;
    const r = (d as { reason?: unknown }).reason;
    return typeof r === "string" ? { ...d, reason: this.text(r) } : d;
  }

  /** The same error, with its message (and stack) masked. */
  error(e: Error): Error {
    if (!this.secrets.length) return e;
    const out = new Error(this.text(e.message));
    out.name = e.name;
    if (e.stack) out.stack = this.text(e.stack);
    return out;
  }

  /** CLI stderr, in whatever chunks it arrives: only whole lines are logged, so a credential
   *  split across two chunks is still matched whole. Lines are masked before they're trimmed, so a
   *  credential that ends in whitespace still matches. */
  write(chunk: string): void {
    if (this.withholding) {
      // The rest of a withheld line is dropped up to its end: what was dropped could be the start
      // of a credential this chunk completes.
      const nl = chunk.indexOf("\n");
      if (nl === -1) return;
      chunk = chunk.slice(nl + 1);
      this.withholding = false;
    }
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.emit(line);
    // A line with no end in sight is logged in pieces. Each cut keeps back at least one less than
    // the longest secret, so a secret not yet complete lies wholly in what's kept; and a cut that
    // would fall inside a run of matches moves back to that run's start, so the run is kept whole
    // too. Nothing a later chunk could complete is ever logged.
    const cap = 64 * 1024;
    if (this.pending.length > cap + this.longest) {
      const cut = this.safeCut();
      if (cut > 0) {
        this.log(this.text(this.pending.slice(0, cut)));
        this.pending = this.pending.slice(cut);
      } else if (this.pending.length > 4 * cap) {
        // One run of matches from the very start, 256 KiB long: the whole line is withheld.
        this.log(`[line withheld: over ${this.pending.length} characters]`);
        this.pending = "";
        this.withholding = true;
      }
    }
  }

  /** Log one line, masked and then trimmed. */
  private emit(line: string): void {
    const out = this.text(line).trimEnd();
    if (out.trim()) this.log(out);
  }

  /** Where `pending` can be cut so that nothing before the cut could be completed by a later
   *  chunk: one less than the longest secret from the end, moved back to the start of any run of
   *  matches it falls inside. */
  private safeCut(): number {
    let cut = this.pending.length - Math.max(this.longest - 1, 0);
    for (const [from, to] of this.spans(this.pending)) if (from < cut && cut < to) cut = from;
    return Math.max(cut, 0);
  }

  /** Log what's left of an unterminated line, except its last few characters (see
   *  {@link safeCut}), which stay pending: stderr can still arrive after a turn ends, and could
   *  complete a credential they start. A withheld line stays withheld. */
  flush(): void {
    if (this.withholding) return;
    const cut = this.safeCut();
    if (cut <= 0) return;
    const head = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.emit(head);
  }

}
