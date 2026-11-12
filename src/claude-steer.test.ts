/**
 * Claude mid-turn steering (the `steer` option). A turn's prompt is a
 * channel that stays open until the turn's last result: the opening message
 * carries the turn id as its client uuid, a steer is pushed onto the same
 * channel, and a result ends the turn only once it has echoed every uuid
 * sent. Covered here: the channel closes on the final result (flag on or off),
 * an intermediate result keeps the turn open, steers are refused unless the
 * turn is live and taking messages, a Stop closes the channel before stopping,
 * and steering is on unless the option turns it off.
 *
 * Driven through the `queryFn` seam: the fake CLI reads the prompt channel the
 * way the SDK does and emits whatever each test scripts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

type QueryArgs = Parameters<typeof query>[0];

/** A scripted CLI: records every prompt message it reads, and emits the SDK
 *  messages a test hands it until the test ends the stream. */
class FakeCli {
  readonly received: SDKUserMessage[] = [];
  inputEnded = false;
  interrupted = false;
  /** When set, `getContextUsage` waits on it, holding the result's judgment open. */
  contextGate: Promise<void> | null = null;
  private readonly out: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private inputWaiters: Array<() => void> = [];

  readonly queryFn = ((args: QueryArgs) => {
    void (async () => {
      for await (const m of args.prompt as AsyncIterable<SDKUserMessage>) {
        this.received.push(m);
        this.notifyInput();
      }
      this.inputEnded = true;
      this.notifyInput();
    })();
    const cli = this;
    const it = (async function* () {
      for (;;) {
        while (cli.out.length) yield cli.out.shift();
        if (cli.ended) return;
        await new Promise<void>((resolve) => {
          cli.wake = resolve;
        });
      }
    })() as AsyncGenerator<unknown> & {
      interrupt?: () => Promise<void>;
      getContextUsage?: () => Promise<unknown>;
    };
    it.interrupt = async () => {
      cli.interrupted = true;
    };
    it.getContextUsage = async () => {
      if (cli.contextGate) await cli.contextGate;
      return null;
    };
    return it;
  }) as unknown as typeof query;

  emit(msg: Record<string, unknown>): void {
    this.out.push(msg);
    this.ping();
  }

  end(): void {
    this.ended = true;
    this.ping();
  }

  /** Resolves once the CLI has read `n` prompt messages. */
  async read(n: number): Promise<void> {
    while (this.received.length < n) await this.nextInput();
  }

  /** Resolves once the prompt channel has closed. */
  async inputClosed(): Promise<void> {
    while (!this.inputEnded) await this.nextInput();
  }

  private nextInput(): Promise<void> {
    return new Promise((resolve) => this.inputWaiters.push(resolve));
  }

  private notifyInput(): void {
    const waiters = this.inputWaiters;
    this.inputWaiters = [];
    for (const w of waiters) w();
  }

  private ping(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** A result frame as the CLI writes it, echoing the prompts it consumed. */
function result(uuids: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    usage: { input_tokens: 1, output_tokens: 1 },
    user_message_uuid: uuids.at(-1),
    user_message_uuids: uuids,
    queued_turn_count: 0,
    ...extra,
  };
}

/** Collects a turn's events as they stream, so a test can act mid-turn. */
class Turn {
  readonly events: TurnStreamEvent[] = [];
  readonly finished: Promise<void>;
  private waiters: Array<() => void> = [];

  constructor(stream: AsyncIterable<TurnStreamEvent>) {
    this.finished = (async () => {
      for await (const ev of stream) {
        this.events.push(ev);
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w();
      }
    })();
  }

  async until(pred: (ev: TurnStreamEvent) => boolean): Promise<TurnStreamEvent> {
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  get turnId(): string {
    const started = this.events.find((e) => e.type === "turn.started");
    assert.ok(started && started.type === "turn.started");
    return started.turnId;
  }

  terminals(): TurnStreamEvent[] {
    return this.events.filter(
      (e) => e.type === "turn.completed" || (e.type === "error.raised" && e.fatal !== false),
    );
  }
}

async function startTurn(opts: { steer?: boolean } = {}) {
  const cli = new FakeCli();
  const provider = new ClaudeAgentProvider({
   queryFn: cli.queryFn,
    ...(opts.steer != null ? { steer: opts.steer } : {}),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const turn = new Turn(provider.sendTurn(thread.id, { text: "how many users?" } as TurnInput));
  await turn.until((e) => e.type === "turn.started");
  await cli.read(1);
  return { cli, provider, threadId: thread.id, turn };
}

/** Let queued microtasks and immediate callbacks run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the opening prompt carries the turn id as its client uuid", async () => {
  const { cli, turn } = await startTurn();
  assert.equal(cli.received[0].uuid, turn.turnId);
  assert.deepEqual(cli.received[0].message, { role: "user", content: "how many users?" });
  cli.emit(result([turn.turnId]));
  cli.end();
  await turn.finished;
});

test("the channel stays open until the final result, then closes", async () => {
  const { cli, turn } = await startTurn({ steer: false });
  await settle();
  assert.equal(cli.inputEnded, false, "the CLI's input stays open while the turn runs");
  cli.emit(result([turn.turnId]));
  await turn.until((e) => e.type === "turn.completed");
  await cli.inputClosed();
  cli.end();
  await turn.finished;
  assert.equal(turn.terminals().length, 1);
});

test("a steer folded between tool rounds rides the same result", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  await provider.steerTurn(threadId, turn.turnId, "split it by app");
  await cli.read(2);
  const steer = cli.received[1];
  assert.deepEqual(steer.message, { role: "user", content: "split it by app" });
  assert.equal(steer.parent_tool_use_id, null);
  assert.ok(steer.uuid && steer.uuid !== turn.turnId);
  assert.equal("priority" in steer, false, "priority stays unset: `now` aborts the round");

  cli.emit(result([turn.turnId, steer.uuid!]));
  await turn.until((e) => e.type === "turn.completed");
  await cli.inputClosed();
  cli.end();
  await turn.finished;
  assert.equal(turn.terminals().length, 1);
});

test("the CLI's echo of a steer is its read receipt; the opening prompt's echo is nothing", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  await provider.steerTurn(threadId, turn.turnId, "split it by app", "steer-1");
  await cli.read(2);
  const replay = (m: SDKUserMessage) => ({ ...m, session_id: "s", isReplay: true });
  cli.emit(replay(cli.received[0]));
  cli.emit(replay(cli.received[1]));
  await turn.until((e) => e.type === "turn.steer.read");
  cli.emit(result([turn.turnId, cli.received[1].uuid!]));
  await turn.until((e) => e.type === "turn.completed");
  cli.end();
  await turn.finished;
  assert.deepEqual(
    turn.events.filter((e) => e.type === "turn.steer.read"),
    [{ type: "turn.steer.read", threadId, steerId: "steer-1" }],
  );
});

test("a result that leaves a steer unanswered keeps the turn open", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  await provider.steerTurn(threadId, turn.turnId, "and by country");
  await cli.read(2);
  const steerUuid = cli.received[1].uuid!;

  // The steer landed after the last tool round: the CLI answers the opening
  // prompt first, then runs the steer as a result of its own.
  cli.emit(result([turn.turnId]));
  await turn.until((e) => e.type === "context.usage");
  await settle();
  assert.equal(turn.terminals().length, 0, "the intermediate result must not end the turn");
  assert.equal(cli.inputEnded, false);

  // The turn is still taking messages after the intermediate result.
  await provider.steerTurn(threadId, turn.turnId, "only for last week");
  await cli.read(3);

  cli.emit(result([steerUuid, cli.received[2].uuid!]));
  await turn.until((e) => e.type === "turn.completed");
  await cli.inputClosed();
  cli.end();
  await turn.finished;
  assert.equal(turn.terminals().length, 1);
});

test("a result with queued sends still pending keeps the turn open", async () => {
  const { cli, turn } = await startTurn({ steer: true });
  cli.emit(result([turn.turnId], { queued_turn_count: 1 }));
  await turn.until((e) => e.type === "context.usage");
  await settle();
  assert.equal(turn.terminals().length, 0);
  cli.emit(result([turn.turnId]));
  await turn.until((e) => e.type === "turn.completed");
  cli.end();
  await turn.finished;
});

test("a result from a producer that echoes no uuids ends the turn", async () => {
  const { cli, turn } = await startTurn({ steer: true });
  cli.emit({ ...result([]), user_message_uuid: undefined, user_message_uuids: undefined });
  await turn.until((e) => e.type === "turn.completed");
  await cli.inputClosed();
  cli.end();
  await turn.finished;
});

test("a steer for another turn, or on a thread with no live turn, is refused", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  await assert.rejects(provider.steerTurn(threadId, "some-other-turn", "hi"), /not the running turn/);
  await assert.rejects(provider.steerTurn("no-such-thread", turn.turnId, "hi"), /not the running turn/);
  assert.equal(cli.received.length, 1, "nothing was delivered");
  cli.emit(result([turn.turnId]));
  cli.end();
  await turn.finished;
});

test("a steer is refused while a result is being judged, and after the turn ends", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  let open!: () => void;
  cli.contextGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  cli.emit(result([turn.turnId]));
  await settle();
  // The result arrived; its context read is in flight, so it is not yet known
  // whether this was the turn's last.
  await assert.rejects(provider.steerTurn(threadId, turn.turnId, "late"), /not taking messages/);
  open();
  await turn.until((e) => e.type === "turn.completed");
  await assert.rejects(provider.steerTurn(threadId, turn.turnId, "later"), /already ended/);
  assert.equal(cli.received.length, 1, "nothing was delivered");
  cli.end();
  await turn.finished;
});

test("with the flag off every steer is refused", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: false });
  assert.equal(provider.supportsSteer, false);
  await assert.rejects(provider.steerTurn(threadId, turn.turnId, "hi"), /not taking messages/);
  cli.emit(result([turn.turnId]));
  cli.end();
  await turn.finished;
});

test("a Stop closes the channel before it interrupts", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  const stopping = provider.interrupt(threadId, turn.turnId);
  await cli.inputClosed();
  await assert.rejects(provider.steerTurn(threadId, turn.turnId, "wait"), /not taking messages/);
  await stopping;
  assert.equal(cli.interrupted, true);
  cli.end();
  await turn.finished;
  assert.equal(turn.terminals().length, 1);
});

test("a failed result with a steer still unanswered stops the CLI", async () => {
  const { cli, provider, threadId, turn } = await startTurn({ steer: true });
  await provider.steerTurn(threadId, turn.turnId, "and by country");
  await cli.read(2);
  cli.emit({
    ...result([turn.turnId]),
    subtype: "error_during_execution",
    is_error: true,
    result: undefined,
    errors: ["the model request failed"],
  });
  await turn.until((e) => e.type === "error.raised");
  await cli.inputClosed();
  await settle();
  assert.equal(cli.interrupted, true, "the CLI must not run the steer behind a failed turn");
  cli.end();
  await turn.finished;
  assert.equal(turn.terminals().length, 1);
});

test("steering is on by default and the steer option turns it off", () => {
  assert.equal(new ClaudeAgentProvider({}).supportsSteer, true);
  assert.equal(new ClaudeAgentProvider({ steer: true }).supportsSteer, true);
  assert.equal(new ClaudeAgentProvider({ steer: false }).supportsSteer, false);
});
