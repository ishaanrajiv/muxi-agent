/**
 * Test helper: options that give a `CodexAgentProvider` a throwaway dedicated
 * home, and an empty "user" home so no real login is linked in.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testCodexHome(): { codexHome: string; userCodexHome: string } {
  const root = mkdtempSync(join(tmpdir(), "muxi-agent-test-"));
  return { codexHome: join(root, "codex-home"), userCodexHome: join(root, "user-codex") };
}
