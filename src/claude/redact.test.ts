import assert from "node:assert/strict";
import { test } from "node:test";

import { mcpSecrets, Redactor } from "./redact.ts";

const servers = { lab: { type: "http" as const, url: "https://h.example/api/mcp?nonce=n0nce&x=1#frag", headers: { k: "ab" } } };

test("every quoted form of a credential is masked", () => {
  const r = new Redactor(mcpSecrets(servers));
  for (const form of [
    "https://h.example/api/mcp?nonce=n0nce&x=1#frag",
    "/api/mcp?nonce=n0nce&x=1",
    "nonce=n0nce&x=1",
    "n0nce",
    encodeURIComponent("https://h.example/api/mcp?nonce=n0nce&x=1#frag"),
    "header ab",
  ]) {
    assert.doesNotMatch(r.text(`at ${form} end`), /n0nce|\bab\b/, form);
  }
});

test("stderr is logged by whole lines; a flush logs the last line but what could still grow into a credential", () => {
  const lines: string[] = [];
  const r = new Redactor(mcpSecrets(servers), (l) => lines.push(l));
  r.write("a https://h.example/api/m");
  r.write("cp?nonce=n0");
  r.write("nce&x=1#frag b\nlast n0n");
  r.write("ce, then " + ".".repeat(300));
  assert.deepEqual(lines, ["a [redacted] b"]);
  r.flush();
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^last \[redacted\], then \.+$/);
});

test("values masks strings only, keeps keys and shape, and stops at depth", () => {
  const r = new Redactor(["a"]);
  const out = r.values({ type: "result", raw: ["a b", 1, null, { a: "a" }] });
  assert.deepEqual(out, { type: "result", raw: ["[redacted] b", 1, null, { a: "[redacted]" }] }, "keys untouched");
  let deep: unknown = "s3cret";
  for (let i = 0; i < 66; i++) deep = { n: deep };
  assert.doesNotMatch(JSON.stringify(new Redactor(["s3cret"]).values(deep)), /s3cret/);
});

test("events keep their shape whatever the secret; diagnostic fields are masked", () => {
  const r = new Redactor(["a", "nonce-xyz"]);
  const err = r.event({ type: "error.raised", threadId: "t", turnId: "u", code: "x", fatal: true, message: "at nonce-xyz", raw: { type: "result", result: "nonce-xyz" } });
  assert.equal(err.type, "error.raised");
  assert.equal(err.threadId, "t");
  assert.ok("raw" in err);
  assert.equal(err.message, "[redacted]t [redacted]");
  const tool = r.event({ type: "tool.completed", threadId: "t", itemId: "i", server: "lab", tool: "x", status: "error", error: "Connection failed: nonce-xyz", result: [{ type: "text", text: "nonce-xyz" }] });
  assert.equal(tool.status, "error");
  assert.doesNotMatch(JSON.stringify([tool.error, tool.result]), /nonce-xyz/);
  const sub = r.event({ type: "agent.subagent.updated", subagentId: "s", error: "nonce-xyz" });
  assert.equal(sub.error, "[redacted]");
  const msg = r.event({ type: "agent.message.completed", text: "nonce-xyz" });
  assert.equal(msg.text, "nonce-xyz", "the model's own text is the host's");
});

test("overlapping secrets leave no fragment; encoded and escaped forms match exactly", () => {
  assert.equal(new Redactor(["abcdef", "defghi"]).text("xabcdefghiy"), "x[redacted]y");
  const r = new Redactor(mcpSecrets({ lab: { type: "http", url: "http://h/mcp/abc%2Fdef", headers: { k: 'q"u\\o/te' } } }));
  for (const form of ["abc/def", "abc%2fdef", "abc%2Fdef", 'q\\"u\\\\o/te', 'q"u\\o/te', "q%22u%5Co%2Fte", "q%22u%5co%2fte"]) {
    assert.equal(r.text(`at ${form} end`), "at [redacted] end", form);
  }
});

/** The lines logged for `chunks` through a redactor for `secrets`, flushed at the end. */
function logged(secrets: string[], chunks: string[]): string[] {
  const lines: string[] = [];
  const r = new Redactor(secrets, (l) => lines.push(l));
  for (const c of chunks) r.write(c);
  r.flush();
  return lines;
}

test("a line past 64 KiB is logged in pieces without leaving any fragment of a secret", () => {
  const long = "x".repeat(65537);
  // The re-review's cases: overlapping secrets straddling the cut, one completed only by the next chunk.
  for (const [secrets, chunks] of [
    [["abcdef", "efghij"], [long + "abcdefgh", "ij\n"]],
    [["defgh", "abcdef"], [long + "abcdefgh", "\n"]],
  ]) {
    const lines = logged(secrets, chunks);
    assert.equal(lines.length, 2, "the 64 KiB cut was taken");
    assert.deepEqual(lines, [long, "[redacted]"]);
  }
  // A plain split.
  const lines = logged(["secret-token"], ["x".repeat(65600) + "secret-", "token\n"]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "xxxx[redacted]");
});

test("a withheld line is dropped to its end, so its tail can't complete a credential", () => {
  assert.deepEqual(logged(["abcdef"], ["abcdef".repeat(43691) + "abc", "def\nnext\n"]), ["[line withheld: over 262149 characters]", "next"]);
  assert.deepEqual(logged(["abcabc"], ["abc".repeat(87383), "abc\n"]), ["[line withheld: over 262149 characters]"]);
});

test("flush keeps back what a later chunk could complete", () => {
  const lines: string[] = [];
  const r = new Redactor(["abcdef"], (l) => lines.push(l));
  r.write("see abc");
  r.flush();
  r.write("def\nnext\n");
  r.flush();
  // "se" is safe to log; "e abc" could still become a credential, so it waits for the next chunk.
  assert.deepEqual(lines, ["se", "e [redacted]", "next"]);
  assert.deepEqual(logged(["abcdef"], ["abcdef".repeat(43691) + "abc"]), ["[line withheld: over 262149 characters]"]);
  assert.deepEqual(logged([], ["no secrets, no newline"]), ["no secrets, no newline"]);
});

test("a credential with a newline in it is masked line by line too", () => {
  const secrets = mcpSecrets({ lab: { type: "http", url: "https://h.example/mcp?token=abc%0Adef" } });
  assert.deepEqual(logged(secrets, ["see abc\n", "def here\n"]), ["see [redacted]", "[redacted] here"]);
  assert.equal(new Redactor(secrets).text("x abc\ndef y"), "x [redacted] y");
});

test("a credential ending in whitespace is masked before the line is trimmed", () => {
  const secrets = mcpSecrets({ lab: { type: "http", url: "https://host.example/mcp", headers: { Authorization: "Bearer secret-token " } } });
  assert.deepEqual(logged(secrets, ["Authorization: Bearer secret-token \n"]), ["Authorization: [redacted]"]);
  const flushed = logged(secrets, ["Authorization: Bearer secret-token " + "x".repeat(300)]);
  assert.equal(flushed.length, 1);
  assert.match(flushed[0]!, /^Authorization: \[redacted\]x+$/);
});

test("refusal reasons are masked on tools and on subagents' calls", () => {
  const r = new Redactor(["nonce-xyz"]);
  const tool = r.event({ type: "tool.completed", threadId: "t", itemId: "i", server: "lab", tool: "x", status: "declined", denial: { by: "classifier", reason: "blocked nonce-xyz" } });
  assert.deepEqual(tool.denial, { by: "classifier", reason: "blocked [redacted]" });
  const sub = r.event({ type: "agent.subagent.updated", subagentId: "s", calls: [{ tool: "x", denial: { by: "rule", reason: "at nonce-xyz" } }, { tool: "y" }] });
  assert.deepEqual(sub.calls, [{ tool: "x", denial: { by: "rule", reason: "at [redacted]" } }, { tool: "y" }]);
});

test("error keeps its name", () => {
  const r = new Redactor(["s3cret"]);
  const e = new TypeError("bad s3cret");
  const out = r.error(e);
  assert.equal(out.name, "TypeError");
  assert.equal(out.message, "bad [redacted]");
  assert.doesNotMatch(out.stack ?? "", /s3cret/);
});
