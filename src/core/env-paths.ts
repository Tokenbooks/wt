import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** An absolute env path that addressed something outside its own worktree. */
export interface EnvPathEscape {
  readonly file: string;
  readonly varName: string;
  readonly value: string;
  readonly rewritten?: string;
}

export interface EnvPathRoots {
  readonly worktreeRoot: string;
  readonly mainRoot: string;
  /** Where sibling worktrees live, from `baseWorktreePath`. */
  readonly worktreesDir: string;
}

export interface RewriteEnvPathsResult {
  readonly content: string;
  readonly escapes: readonly EnvPathEscape[];
}

// `[\s\S]` not `.` so a CRLF line's carriage return still matches.
const ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Find the git working tree enclosing a path, which need not exist.
 * A primary checkout has a `.git` directory, a linked worktree a `.git` file.
 *
 * @example
 * findEnclosingCheckout('/home/dev/proj/apps/runner/bin'); // returns '/home/dev/proj'
 */
export function findEnclosingCheckout(absolutePath: string): string | undefined {
  let dir = path.resolve(absolutePath);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Expand a leading `~/` against the current user's home directory. */
function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Whether the value is one absolute path. A colon means a `PATH` list, so skip it. */
function isAbsolutePathValue(value: string): boolean {
  if (value.includes(':')) return false;
  return value.startsWith('/') || value.startsWith('~/');
}

/** Physical location, so two spellings of one checkout compare equal. */
function canonical(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSamePath(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

/** Whether a checkout is the main worktree or one of its siblings. */
function isRelatedCheckout(checkout: string, roots: EnvPathRoots): boolean {
  return (
    isSamePath(checkout, roots.mainRoot) ||
    isSamePath(path.dirname(checkout), roots.worktreesDir)
  );
}

/**
 * Undefined to leave the value alone, `{}` to report it without rewriting.
 * See docs/env-path-isolation.md.
 */
function resolveWorktreePath(
  value: string,
  roots: EnvPathRoots,
): { readonly rewritten?: string } | undefined {
  const absolute = expandHome(value);
  const checkout = findEnclosingCheckout(absolute);
  if (!checkout) return undefined;
  if (isSamePath(checkout, roots.worktreeRoot)) return undefined;
  if (!isRelatedCheckout(checkout, roots)) return {};
  return {
    rewritten: path.join(roots.worktreeRoot, path.relative(checkout, absolute)),
  };
}

interface ParsedValue {
  readonly value: string;
  readonly quote: string;
  /** Trailing text such as an inline comment, restored verbatim. */
  readonly suffix: string;
}

/**
 * Split a value from the text trailing it, so only the path is rewritten.
 * Undefined when a quote is never closed.
 *
 * @example
 * parseValue('"/opt/tool" # notes'); // returns value '/opt/tool', quote '"', suffix ' # notes'
 */
function parseValue(rawValue: string): ParsedValue | undefined {
  const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';
  if (quote) {
    const closing = rawValue.indexOf(quote, 1);
    if (closing === -1) return undefined;
    return {
      value: rawValue.slice(1, closing),
      quote,
      suffix: rawValue.slice(closing + 1),
    };
  }

  const match = rawValue.match(/^(\S*)([\s\S]*)$/);
  return { value: match![1]!, quote: '', suffix: match![2]! };
}

/**
 * Repoint absolute paths at this worktree and report every escape.
 * Paths in no checkout, such as `/usr/bin/node`, are left alone.
 *
 * @example
 * rewriteEnvPaths('BIN=/proj/bin/tool', 'server/.env', roots);
 * // returns 'BIN=/proj/.worktrees/x/bin/tool' plus one escape
 */
export function rewriteEnvPaths(
  content: string,
  file: string,
  roots: EnvPathRoots,
): RewriteEnvPathsResult {
  const escapes: EnvPathEscape[] = [];

  const lines = content.split('\n').map((line) => {
    const match = line.match(ASSIGNMENT_PATTERN);
    if (!match) return line;

    const [, prefix, varName, rawValue] = match;
    const parsed = parseValue(rawValue!);
    if (!parsed || !isAbsolutePathValue(parsed.value)) return line;

    const resolved = resolveWorktreePath(parsed.value, roots);
    if (!resolved) return line;

    escapes.push({ file, varName: varName!, value: parsed.value, rewritten: resolved.rewritten });
    if (!resolved.rewritten) return line;
    return `${prefix}${varName}=${parsed.quote}${resolved.rewritten}${parsed.quote}${parsed.suffix}`;
  });

  return { content: lines.join('\n'), escapes };
}
