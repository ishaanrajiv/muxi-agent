import { test } from "node:test";
import assert from "node:assert/strict";

import { authFromAccount, isUnknownMethod } from "./codex-account.ts";
import type { Account } from "./generated/v2/Account.ts";
import { claudeHelpOffersLogout } from "./claude/auth.ts";

test("authFromAccount reads a ChatGPT plan and email off account/read", () => {
  const auth = authFromAccount({
    account: { type: "chatgpt", email: "user@example.com", planType: "team", workspaceName: null },
    requiresOpenaiAuth: true,
    workspaceRouting: null,
  });
  assert.deepEqual(auth, {
    status: "authenticated",
    method: "chatgpt",
    label: "ChatGPT Team",
    email: "user@example.com",
  });
});

test("authFromAccount keeps a plan type it has no copy for readable", () => {
  const auth = authFromAccount({
    // Codex ships plan types faster than the generated union tracks them.
    account: { type: "chatgpt", email: "", planType: "ent27" as "unknown", workspaceName: null },
    requiresOpenaiAuth: true,
    workspaceRouting: null,
  });
  assert.equal(auth.label, "ChatGPT");
  assert.equal(auth.email, undefined);
});

test("authFromAccount labels the non-subscription logins", () => {
  assert.equal(
    authFromAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null }).label,
    "OpenAI API key",
  );
  assert.equal(
    // Newer codex builds add fields to this variant; the label reads `type` only.
    authFromAccount({ account: { type: "amazonBedrock" } as Account, requiresOpenaiAuth: true, workspaceRouting: null })
      .label,
    "Amazon Bedrock",
  );
});

test("no account is signed out only when codex says a login is required", () => {
  assert.equal(
    authFromAccount({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }).status,
    "unauthenticated",
  );
  // A codex pointed at a provider needing no OpenAI login is working, not
  // unverified — reporting `unknown` here would leave a permanent warning.
  assert.equal(
    authFromAccount({ account: null, requiresOpenaiAuth: false, workspaceRouting: null }).status,
    "authenticated",
  );
});

test("isUnknownMethod recognises how codex rejects a method it doesn't have", () => {
  // The shape codex 0.150 actually returns, via CodexClient's error wrapper.
  assert.equal(
    isUnknownMethod(
      new Error(
        "RPC error -32600: Invalid request: unknown variant `account/logout`, " +
          "expected one of `initialize`, `thread/start`",
      ),
    ),
    true,
  );
  assert.equal(isUnknownMethod(new Error("RPC error -32601: Method not found")), true);
  assert.equal(isUnknownMethod(new Error("Request account/read (id=2) timed out")), false);
  assert.equal(isUnknownMethod(new Error("spawn codex ENOENT")), false);
});

test("claudeHelpOffersLogout reads the auth subcommand listing", () => {
  const help = [
    "Usage: claude auth [options] [command]",
    "",
    "Commands:",
    "  login [options]   Sign in to your Anthropic account",
    "  logout            Log out from your Anthropic account",
    "  status [options]  Show authentication status",
  ].join("\n");
  assert.equal(claudeHelpOffersLogout(help), true);
  assert.equal(
    claudeHelpOffersLogout("Commands:\n  login [options]   Sign in\n  status  Show status"),
    false,
  );
  // A description that merely mentions signing out is not the command.
  assert.equal(claudeHelpOffersLogout("  status  Show status, or logout state"), false);
});
