// After `pnpm generate`: record which codex CLI produced src/generated in
// package.json (`codexBindings.codexCli`), so the bindings' origin is explicit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const out = execFileSync("codex", ["--version"], { encoding: "utf8" });
const version = /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1];
if (!version) throw new Error(`could not read a version from: ${out}`);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.codexBindings = { ...pkg.codexBindings, codexCli: version };
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`src/generated now from codex ${version}`);
