// Builds dist/ from src/ with tsc. Run by `prepare`, so installing this
// package from a git commit produces a ready-to-import build.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit", cwd: root });

// The generated Codex bindings import each other without file extensions,
// which a consumer type-checking under `nodenext` rejects. Give every relative
// specifier in dist/generated its `.js` (or `/index.js`) so the declarations
// resolve under any module setting.
const generated = join(dist, "generated");
const specifier = /(from\s+["'])(\.{1,2}\/[^"']*?)(["'])/g;
function fixDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) fixDir(file);
    else if (/\.(d\.ts|js)$/.test(entry.name)) {
      const text = readFileSync(file, "utf8");
      const fixed = text.replace(specifier, (whole, open, spec, close) => {
        if (/\.(js|mjs|cjs|json)$/.test(spec)) return whole;
        const target = resolve(dir, spec);
        if (existsSync(`${target}.d.ts`) || existsSync(`${target}.js`)) return `${open}${spec}.js${close}`;
        if (existsSync(join(target, "index.d.ts"))) return `${open}${spec}/index.js${close}`;
        return whole;
      });
      if (fixed !== text) writeFileSync(file, fixed);
    }
  }
}
if (existsSync(generated)) fixDir(generated);
