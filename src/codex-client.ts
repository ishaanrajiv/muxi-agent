/**
 * Codex app-server JSON-RPC client (stdio transport).
 *
 * Spawns `codex app-server` as a child process, sends/receives newline-
 * delimited JSON-RPC messages, and dispatches notifications + approval
 * requests to registered handlers.
 *
 * This is intentionally small, but it still owns the app-server protocol
 * lifecycle: request/response correlation, server-initiated requests,
 * notifications, and process shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";

import type { RequestId } from "./generated/RequestId.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";
import type { ModelListParams } from "./generated/v2/ModelListParams.ts";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.ts";

// ── JSON-RPC primitives ──────────────────────────────────────────────────

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type ServerMessage =
  | ServerNotification
  | ServerRequest
  | JsonRpcResponse;

// ── Public types ─────────────────────────────────────────────────────────

export interface CodexClientOptions {
  /** Path to the codex binary (default: "codex"). */
  codexBin?: string;
  /** Extra CLI args for `codex app-server`. */
  extraArgs?: string[];
  /** Working directory for the app-server process. */
  cwd?: string;
  /** Env vars to set for the app-server process. */
  env?: Record<string, string>;
  /** Append every JSON-RPC frame, both directions, to this file as NDJSON
   *  (`{d: "in" | "out", t: ms since start, m: message}`). Defaults to
   *  `MUXI_AGENT_CODEX_WIRE_LOG`; unset means no capture. Feeds the fixture recorder
   *  (`scripts/record-codex-fixtures.ts`). */
  wireLogPath?: string;
}

export type NotificationHandler = (notification: ServerNotification) => void;
export type ApprovalHandler = (request: ServerRequest) => void;

/** Default ceiling on a JSON-RPC round trip before the caller is failed. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How much app-server stderr to keep for failure diagnostics. */
const STDERR_TAIL_BYTES = 4096;
/** How many of those lines to quote in a thrown message. */
const STDERR_TAIL_LINES = 8;

// ── Client ───────────────────────────────────────────────────────────────

export class CodexClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  /** Rolling tail of the app-server's stderr (see {@link stderrTail}). */
  private stderrRing = "";
  /** True only between a successful spawn and the process's error/exit. */
  private spawned = false;
  /** Bumped on every spawn. A process's handlers act only while it is the
   *  newest: one that exits after a respawn must not fail the new one's requests. */
  private generation = 0;
  private pending = new Map<
    RequestId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private opts: Required<Omit<CodexClientOptions, "wireLogPath">>;
  private readonly wireLogPath: string | undefined;
  private wireStartedAt = 0;

  constructor(opts: CodexClientOptions = {}) {
    super();
    this.opts = {
      codexBin: opts.codexBin ?? "codex",
      extraArgs: opts.extraArgs ?? [],
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? {},
    };
    this.wireLogPath = opts.wireLogPath ?? (process.env.MUXI_AGENT_CODEX_WIRE_LOG || undefined);
  }

  /** Spawn the app-server process and initialise the JSON-RPC session. */
  async start(): Promise<void> {
    const args = ["app-server", "--listen", "stdio://", ...this.opts.extraArgs];

    this.stderrRing = "";
    this.wireStartedAt = Date.now();
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.proc = spawn(this.opts.codexBin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Cleared again the moment the child errors (ENOENT) or exits, so a process
    // that never really came up never reports as running.
    this.spawned = true;

    this.proc.on("error", (err) => {
      if (!current()) return;
      this.spawned = false;
      this.failPending(this.withStderrTail(err));
      // Only re-emit when someone is listening: sendTurn subscribes per-turn,
      // but idle-path spawns (usage/model reads) have no listener, and Node
      // turns a listenerless "error" emit into an uncaught exception — a
      // missing codex binary must fail the caller, not kill the process.
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    this.proc.on("exit", (code) => {
      if (!current()) return;
      this.spawned = false;
      this.failPending(
        this.withStderrTail(new Error(`Codex app-server exited with code ${code ?? "unknown"}`)),
      );
      this.emit("exit", code);
    });
    // A write that lands after the child has closed its end of the pipe fails
    // asynchronously as EPIPE on the stdin stream, not as a throw from write().
    // Without a listener that is an uncaught exception; with one, the pending
    // requests fail the same way they do on "exit" (which follows shortly).
    this.proc.stdin?.on("error", (err) => {
      if (!current()) return;
      this.failPending(this.withStderrTail(err));
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));

    // Pipe stderr for debug logging, keeping a bounded tail: when the process
    // panics or prints an auth diagnostic on the way out, that text is the only
    // explanation the caller can be given (see {@link withStderrTail}).
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      if (!current()) return;
      const text = chunk.toString();
      this.stderrRing = (this.stderrRing + text).slice(-STDERR_TAIL_BYTES);
      this.emit("stderr", text);
    });

    // Wait for the child to actually come up: Node emits "spawn" once the
    // process has been created, and "error" instead when it could not be
    // (ENOENT — codex not installed / not on PATH). Exactly one of the two
    // always fires, so racing them settles as soon as the outcome is known and
    // a spawn failure rejects here, giving ensureStarted() callers the real
    // error immediately.
    const proc = this.proc;
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        proc.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        proc.removeListener("spawn", onSpawn);
        // Already annotated with any stderr tail by the handler above (it is
        // registered first, so it runs first on the same error object).
        reject(err);
      };
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    });
  }

  /** Send the initialize handshake. */
  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "muxi-agent", version: "0.1.0" },
      // `experimentalApi` unlocks `thread/{increment,decrement}_elicitation`
      // (gated since codex-cli 0.155), which pause a thread's timeout clock
      // while a human answers a question (see
      // CodexAgentProvider.pauseTimeoutAccounting). Questions themselves are
      // forwarded regardless of this flag.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", undefined);
    return result;
  }

  /** Start a new thread. */
  async threadStart(params: ThreadStartParams): Promise<unknown> {
    return this.request("thread/start", params);
  }

  /** Start a new turn in an existing thread. */
  async turnStart(params: TurnStartParams): Promise<unknown> {
    return this.request("turn/start", params);
  }

  /** Fold a user message into the turn already running (`expectedTurnId` is the
   *  app-server's precondition on which turn it may land in). `timeoutMs` bounds
   *  the round trip — a steer is answered inline on an HTTP request, so its
   *  caller cannot wait out the default ceiling. */
  async turnSteer(params: TurnSteerParams, timeoutMs?: number): Promise<TurnSteerResponse> {
    return this.request("turn/steer", params, timeoutMs) as Promise<TurnSteerResponse>;
  }

  /** List the models the active login/subscription offers (`model/list`). */
  async modelList(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request("model/list", params) as Promise<ModelListResponse>;
  }

  /** Resolve an approval request (approve or deny). */
  async resolveApproval(requestId: RequestId, response: unknown): Promise<void> {
    this.sendRaw({ id: requestId, result: response });
  }

  /** Reject a server-initiated JSON-RPC request. */
  async rejectServerRequest(
    requestId: RequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.sendRaw({ id: requestId, error });
  }

  /** Send a raw JSON-RPC notification. */
  notify(method: string, params: unknown): void {
    const msg =
      params === undefined
        ? { method }
        : { method, params };
    this.sendRaw(msg);
  }

  /** Send a raw JSON-RPC request and wait for the response. `timeoutMs` overrides
   *  the default {@link REQUEST_TIMEOUT_MS} ceiling for callers that answer a
   *  waiting client and so must fail fast instead of hanging on the app-server. */
  async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, timeoutMs);
      // A dead app-server must never pin the event loop for the whole timeout:
      // the process should be free to exit, and the pending caller is failed by
      // the child's own "error"/"exit" handlers (failPending) in that case.
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw({ method, id, params });
      } catch (err) {
        // The request never went out, so nothing will ever answer it: retire
        // the entry and its timer here rather than leaving both live.
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Gracefully shut down the app-server. */
  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.spawned = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // Reject rather than drop: dropping a pending entry (with its timer) leaves
    // its awaiting caller — getUsage, thread/start, thread/resume — hung forever,
    // and the `exit` handler that would have failed it finds an empty map.
    this.failPending(new Error("Codex app-server was stopped before the request completed"));
  }

  /** Whether a successfully spawned app-server process is still alive. */
  get isRunning(): boolean {
    return this.proc !== null && this.spawned && !this.proc.killed;
  }

  /**
   * The last few lines the app-server wrote to stderr, trimmed. Empty when it
   * said nothing. Callers append this to failure messages so an exit code isn't
   * the whole story.
   */
  get stderrTail(): string {
    return this.stderrRing
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .slice(-STDERR_TAIL_LINES)
      .join("\n")
      .trim();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private sendRaw(msg: unknown): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("App-server stdin not writable");
    }
    const line = JSON.stringify(msg);
    this.proc.stdin.write(line + "\n");
    this.logWire("out", msg);
  }

  /** One frame to the wire log, when capture is on. Synchronous so frames keep
   *  their order; this is a recording mode, never on in normal runs. */
  private logWire(d: "in" | "out", m: unknown): void {
    if (!this.wireLogPath) return;
    appendFileSync(this.wireLogPath, JSON.stringify({ d, t: Date.now() - this.wireStartedAt, m }) + "\n");
  }

  private handleLine(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
      this.logWire("in", msg);
    } catch {
      this.logWire("in", raw);
      // Corrupted protocol line: if it still names a request we're awaiting,
      // fail that caller now instead of letting it wait out the 60s timeout.
      // A truncated NOTIFICATION can carry an unrelated id (a thread/turn id, or
      // an item id) that collides with a live request id, so only a line that
      // plausibly IS a response may settle one — see {@link looksLikeResponse}.
      const id = looksLikeResponse(raw) ? scrapeRequestId(raw) : null;
      if (id == null || !this.rejectPending(id, new Error(`Malformed app-server response (id=${id})`))) {
        console.warn(`[codex-client] unparsable app-server line: ${truncate(raw)}`);
      }
      this.emit("parse-error", raw);
      return;
    }

    // JSON-RPC response (has id + result/error, no method)
    if ("id" in msg && !("method" in msg)) {
      const rpc = msg as JsonRpcResponse;
      const handler = this.pending.get(rpc.id);
      if (handler) {
        this.pending.delete(rpc.id);
        clearTimeout(handler.timer);
        if (rpc.error) {
          const data = rpc.error.data !== undefined ? ` (${describe(rpc.error.data)})` : "";
          handler.reject(
            new Error(`RPC error ${rpc.error.code}: ${rpc.error.message}${data}`)
          );
        } else {
          handler.resolve(rpc.result);
        }
      } else {
        console.warn(`[codex-client] response for unknown request id=${String(rpc.id)}`);
      }
      return;
    }

    // Server request (has id + method — needs a response from us)
    if ("id" in msg && "method" in msg) {
      this.emit("approval", msg as ServerRequest);
      return;
    }

    // Server notification (method only, no id)
    if ("method" in msg) {
      this.emit("notification", msg as ServerNotification);
      return;
    }
  }

  private failPending(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  /** Reject one pending request by id. False when no such request is in flight. */
  private rejectPending(id: RequestId, err: Error): boolean {
    const handler = this.pending.get(id);
    if (!handler) return false;
    this.pending.delete(id);
    clearTimeout(handler.timer);
    handler.reject(err);
    return true;
  }

  /** Append the app-server's own last words to a failure, when it left any. */
  private withStderrTail(err: Error): Error {
    const tail = this.stderrTail;
    if (tail) err.message = `${err.message}: ${tail}`;
    return err;
  }
}

/** Best-effort `id` scrape from a line `JSON.parse` rejected. */
/**
 * Whether a line we couldn't parse plausibly is a JSON-RPC RESPONSE, and so may
 * settle a pending request: it carries a top-level `result`/`error` and names no
 * method. Notifications and server requests always carry `method` (and it is
 * written before the payload, so truncation keeps it), which is what separates
 * them from a cut-off response here.
 */
function looksLikeResponse(raw: string): boolean {
  if (/"method"\s*:/.test(raw)) return false;
  return /"(?:result|error)"\s*:/.test(raw);
}

function scrapeRequestId(raw: string): RequestId | null {
  const m = /"id"\s*:\s*(?:(\d+)|"([^"]*)")/.exec(raw);
  if (!m) return null;
  return m[1] != null ? Number(m[1]) : m[2]!;
}

function truncate(s: string, max = 200): string {
  const line = s.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function describe(data: unknown): string {
  if (typeof data === "string") return truncate(data);
  try {
    return truncate(JSON.stringify(data) ?? String(data));
  } catch {
    return String(data);
  }
}
