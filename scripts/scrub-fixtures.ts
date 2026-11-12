#!/usr/bin/env node
/**
 * Re-scrub every recorded fixture in place (`fixtures/<dir>/*.ndjson`) with
 * `scripts/lib/fixture-scrub.ts`. The recorder already scrubs what it writes;
 * this is for fixtures recorded before a scrub rule existed. Idempotent.
 *
 *   node scripts/scrub-fixtures.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { scrubFixture } from "./lib/fixture-scrub.ts";

const fixtures = join(resolve(dirname(new URL(import.meta.url).pathname), ".."), "fixtures");

for (const dir of readdirSync(fixtures, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const name of readdirSync(join(fixtures, dir.name))) {
    if (!name.endsWith(".ndjson")) continue;
    const file = join(fixtures, dir.name, name);
    const before = readFileSync(file, "utf8");
    const lines = before.trim().split("\n").map((l) => JSON.parse(l));
    const after = scrubFixture(lines).map((l) => JSON.stringify(l)).join("\n") + "\n";
    if (after !== before) writeFileSync(file, after);
    console.log(`${after === before ? "unchanged" : "scrubbed "} ${dir.name}/${name}`);
  }
}
