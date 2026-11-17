/**
 * The Codex executable a provider spawns. Codex runs every sandboxed shell
 * command by re-running its own executable inside the sandbox, and a workspace
 * thread's sandbox hides the user's credential folders, `~/.codex` among them.
 * An install that lives there (the standalone installer's default) therefore
 * can't run a single command in workspace mode. Such an install is staged
 * outside the hidden folders: its package folder mirrored with hard links, so
 * the bytes are the same and nothing is downloaded or rebuilt.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

/** The file that marks the root of a standalone Codex package. */
const PACKAGE_MARKER = "codex-package.json";

export function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of the executable `codexBin` names: a path as given, a bare
 *  name through `PATH`. Null when there is no such file. */
export function realCodexBin(codexBin: string, pathEnv = process.env.PATH ?? ""): string | null {
  const candidates = codexBin.includes(sep) ? [codexBin] : pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, codexBin));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isFile()) return real;
    } catch {
      // Not here; try the next folder on PATH.
    }
  }
  return null;
}

export interface StageOptions {
  /** Folders the workspace sandbox hides. */
  hidden: string[];
  /** Where a hidden install is mirrored. The sandboxed shell must not be able
   *  to write here: a hard link shares its bytes with the original. */
  stageDir: string;
  pathEnv?: string;
}

/**
 * The executable to spawn for `codexBin`: itself, unless it sits in a hidden
 * folder, in which case the staged copy. A staging that fails leaves `codexBin`
 * as it was; workspace mode then refuses the thread (see {@link hiddenCodexBin}).
 */
export function sandboxVisibleCodexBin(codexBin: string, opts: StageOptions): string {
  const real = realCodexBin(codexBin, opts.pathEnv);
  if (!real || !opts.hidden.some((dir) => isWithin(real, dir))) return codexBin;
  try {
    const pkg = packageRoot(real);
    const staged = join(opts.stageDir, basename(pkg));
    mirror(pkg, staged);
    return join(staged, relative(pkg, real));
  } catch (err) {
    console.warn(`[muxi-agent:codex] could not stage the codex executable outside the sandbox's hidden folders: ${(err as Error).message}`);
    return codexBin;
  }
}

/** The hidden folder that holds the executable `codexBin` names, or null. */
export function hiddenCodexBin(codexBin: string, hidden: string[], pathEnv?: string): string | null {
  const real = realCodexBin(codexBin, pathEnv);
  return (real && hidden.find((dir) => isWithin(real, dir))) ?? null;
}

/** The package folder around an executable: the nearest folder (up to three
 *  above it) with the package marker, else the executable's own folder. */
function packageRoot(real: string): string {
  let dir = dirname(real);
  for (let i = 0; i < 3; i += 1) {
    if (existsSync(join(dir, PACKAGE_MARKER))) return dir;
    dir = dirname(dir);
  }
  return dirname(real);
}

/** Mirror `from` into `to`: folders made, symlinks recreated, files hard-linked
 *  (copied across filesystems). A file already linked to its source is left. */
function mirror(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    const stat = lstatSync(src);
    if (stat.isDirectory()) {
      mirror(src, dest);
      continue;
    }
    const have = lstatSync(dest, { throwIfNoEntry: false });
    if (stat.isSymbolicLink()) {
      if (have?.isSymbolicLink() && readlinkSync(dest) === readlinkSync(src)) continue;
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(readlinkSync(src), dest);
      continue;
    }
    if (have && have.ino === stat.ino && have.dev === stat.dev) continue;
    if (have && have.size === stat.size && have.mtimeMs >= stat.mtimeMs && have.dev !== stat.dev) continue;
    rmSync(dest, { recursive: true, force: true });
    try {
      linkSync(src, dest);
    } catch {
      copyFileSync(src, dest);
    }
  }
}
