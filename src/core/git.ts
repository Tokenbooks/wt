import { execFileSync, execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

type CommandLogger = (command: string) => void;

/**
 * The helpers below build shell command strings, always interpolating a ref
 * inside double quotes. Within double quotes `sh` only treats `"`, backtick,
 * `$` and `\` specially — and git happily accepts all four in a ref name — so
 * refuse exactly those (plus control characters) instead of quoting around
 * them. Everything else, including non-ASCII branch names, passes untouched.
 */
const UNSAFE_REF_PATTERN = /["`$\\\p{Cc}]/u;

function assertSafeRef(ref: string, label: string): void {
  if (ref.length === 0 || UNSAFE_REF_PATTERN.test(ref)) {
    throw new Error(`${label} '${ref}' contains unsupported characters`);
  }
}

export interface PrunableWorktree {
  readonly path: string;
  readonly reason: string;
}

export type WorktreeBranchSource = 'origin' | 'local-new' | 'local-existing';

export interface WorktreeBranchSelection {
  readonly branchName: string;
  readonly source: WorktreeBranchSource;
  readonly sourceLabel: string;
  readonly startPoint?: string;
  readonly originCheckError?: string;
}

/**
 * Get the main (bare) worktree path from git.
 * Parses `git worktree list --porcelain` to find the first entry.
 */
export function getMainWorktreePath(): string {
  const output = execSync('git worktree list --porcelain', {
    encoding: 'utf-8',
  });
  const firstLine = output.split('\n')[0];
  if (!firstLine?.startsWith('worktree ')) {
    throw new Error('Could not determine main worktree path');
  }
  return firstLine.replace('worktree ', '');
}

/**
 * Check if the given path is the main (primary) worktree.
 * Compares resolved paths against the first entry in worktree list.
 */
export function isMainWorktree(targetPath: string): boolean {
  const mainPath = getMainWorktreePath();
  return path.resolve(targetPath) === path.resolve(mainPath);
}

/**
 * Create a new git worktree at the given base path for the specified branch.
 * The branch selection must already be resolved before calling this helper.
 */
export function createWorktree(
  basePath: string,
  branch: WorktreeBranchSelection,
  logCommand?: CommandLogger,
): string {
  const slug = branch.branchName.replace(/\//g, '-');
  const worktreePath = path.resolve(basePath, slug);
  const command = buildWorktreeAddCommand(worktreePath, branch);
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
  return worktreePath;
}

/**
 * Resolve which branch ref should back a new worktree.
 *
 * Precedence: an existing local branch is checked out as-is, else a matching
 * `origin` branch is fetched and tracked, else a fresh local branch is created.
 * Only that last "fresh local branch" case honours `opts.base` as the start
 * point to fork from; when the branch already exists locally or on origin the
 * base is inert (callers should surface that to the user).
 *
 * `opts.skipOriginLookup` forces the fresh-branch case: set it for a name wt
 * invented itself, where adopting an unrelated remote branch that happens to
 * share the name would be the opposite of what the caller asked for — and
 * where probing origin is a pointless round trip.
 */
export function resolveWorktreeBranch(
  branchName: string,
  logCommand?: CommandLogger,
  opts?: { base?: string; skipOriginLookup?: boolean },
): WorktreeBranchSelection {
  assertSafeRef(branchName, 'branch');
  if (opts?.base !== undefined) {
    assertSafeRef(opts.base, 'base ref');
  }

  if (branchExistsLocally(branchName)) {
    return {
      branchName,
      source: 'local-existing',
      sourceLabel: 'existing local branch',
    };
  }

  if (opts?.skipOriginLookup) {
    return {
      branchName,
      source: 'local-new',
      sourceLabel: 'fresh local branch',
      startPoint: opts.base,
    };
  }

  try {
    if (branchExistsOnOrigin(branchName, logCommand)) {
      fetchOriginBranch(branchName, logCommand);
      return {
        branchName,
        source: 'origin',
        sourceLabel: `origin/${branchName}`,
        startPoint: `origin/${branchName}`,
      };
    }
  } catch (err) {
    return {
      branchName,
      source: 'local-new',
      sourceLabel: 'fresh local branch',
      startPoint: opts?.base,
      originCheckError: extractCommandErrorMessage(err),
    };
  }

  return {
    branchName,
    source: 'local-new',
    sourceLabel: 'fresh local branch',
    startPoint: opts?.base,
  };
}

/** Remove a git worktree by path */
export function removeWorktree(
  worktreePath: string,
  logCommand?: CommandLogger,
): void {
  const command = `git worktree remove "${worktreePath}" --force`;
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
}

/**
 * Delete a local branch. Uses `-d`, so a branch carrying commits the base ref
 * does not already have is refused rather than destroyed.
 */
export function deleteBranch(branchName: string, logCommand?: CommandLogger): void {
  assertSafeRef(branchName, 'branch');
  const command = `git branch -d "${branchName}"`;
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
}

/** Get the current branch name for a worktree path */
export function getBranchName(worktreePath: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();
}

/** Get uncommitted changes in a worktree (staged, unstaged, untracked) */
export function getUncommittedChanges(worktreePath: string): string[] {
  const output = execSync('git status --porcelain', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();
  return output.length > 0 ? output.split('\n') : [];
}

/** Get commits not pushed to upstream tracking branch */
export function getUnsyncedStatus(worktreePath: string): {
  unpushedCommits: string[];
  noUpstream: boolean;
} {
  try {
    const output = execSync('git log @{upstream}..HEAD --oneline', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return {
      unpushedCommits: output.length > 0 ? output.split('\n') : [],
      noUpstream: false,
    };
  } catch {
    return { unpushedCommits: [], noUpstream: true };
  }
}

/** List worktrees that Git currently marks as prunable. */
export function listPrunableWorktrees(): PrunableWorktree[] {
  const output = execSync('git worktree list --porcelain', {
    encoding: 'utf-8',
  });
  const blocks = output
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const prunable: PrunableWorktree[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    const prunableLine = lines.find((line) => line.startsWith('prunable '));
    if (!worktreeLine || !prunableLine) {
      continue;
    }

    prunable.push({
      path: worktreeLine.replace('worktree ', ''),
      reason: prunableLine.replace('prunable ', ''),
    });
  }

  return prunable;
}

/** Remove Git metadata for prunable worktrees. */
export function pruneWorktrees(logCommand?: CommandLogger): void {
  const command = 'git worktree prune --verbose';
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
}

/** Check if a branch exists locally */
function branchExistsLocally(branchName: string): boolean {
  try {
    execSync(`git rev-parse --verify "refs/heads/${branchName}"`, {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a throwaway branch name for `wt new` when no name is given, e.g.
 * `main-20260723-nemanull`. The base, local date, and current user keep it
 * greppable and unique; collisions with existing local branches get a numeric
 * suffix (`-2`, `-3`, ...).
 */
export function generateAutoBranchName(base: string): string {
  assertSafeRef(base, 'base ref');
  const stem = `${slugifyBase(base)}-${currentDateStamp()}-${currentUserSlug()}`;
  let candidate = stem;
  let suffix = 2;
  while (branchExistsLocally(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Throw a clean error if a git ref (branch, tag, or commit) does not resolve.
 * Runs without a shell so an unresolvable ref can never be executed as one.
 */
export function assertRefExists(ref: string): void {
  assertSafeRef(ref, 'base ref');
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(`base ref '${ref}' not found`);
  }
}

/**
 * Reduce a base ref to a branch-name-safe stem — `origin/release/2.0` becomes
 * `release-2.0`, `HEAD~2` becomes `HEAD-2` — so the generated name is always a
 * name git will accept. Revision syntax that slugs away entirely falls back to
 * a literal so the name never starts with a separator.
 */
function slugifyBase(base: string): string {
  const slug = stripDiacritics(base.replace(/^origin\//, ''))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'base';
}

/** Local-time YYYYMMDD stamp (not UTC — matches the user's own calendar day). */
function currentDateStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * A branch-safe token identifying the current user. Prefers the OS login name
 * (already a single safe token), falling back to a slugified `git config
 * user.name`, and finally the literal `wt`.
 */
function currentUserSlug(): string {
  try {
    const slug = slugifyToken(os.userInfo().username);
    if (slug) {
      return slug;
    }
  } catch {
    // os.userInfo() throws on some uid-less environments; fall through.
  }

  try {
    const gitName = execSync('git config user.name', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    const slug = slugifyToken(gitName);
    if (slug) {
      return slug;
    }
  } catch {
    // No git identity configured; fall through to the default.
  }

  return 'wt';
}

/** NFKD-normalize and drop combining marks, so `ü` reduces to `u`. */
function stripDiacritics(raw: string): string {
  return raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, strip diacritics, and reduce to a `[a-z0-9-]` branch-safe slug. */
function slugifyToken(raw: string): string {
  return stripDiacritics(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildWorktreeAddCommand(
  worktreePath: string,
  branch: WorktreeBranchSelection,
): string {
  switch (branch.source) {
    case 'origin':
      return `git worktree add "${worktreePath}" --track -b "${branch.branchName}" "${branch.startPoint}"`;
    case 'local-existing':
      return `git worktree add "${worktreePath}" "${branch.branchName}"`;
    case 'local-new':
      return branch.startPoint
        ? `git worktree add "${worktreePath}" -b "${branch.branchName}" "${branch.startPoint}"`
        : `git worktree add "${worktreePath}" -b "${branch.branchName}"`;
  }
}

function branchExistsOnOrigin(
  branchName: string,
  logCommand?: CommandLogger,
): boolean {
  const command = `git ls-remote --exit-code --heads origin "${branchName}"`;
  logCommand?.(command);

  try {
    execSync(command, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    if (getExitStatus(err) === 2) {
      return false;
    }
    throw err;
  }
}

function fetchOriginBranch(
  branchName: string,
  logCommand?: CommandLogger,
): void {
  const command =
    `git fetch origin "refs/heads/${branchName}:refs/remotes/origin/${branchName}"`;
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
}

function getExitStatus(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number'
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

function extractCommandErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err) || 'Unknown error';
  }
  if ('stderr' in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) {
      return stderr;
    }
  }
  if (err.message) {
    return err.message;
  }
  return String(err) || 'Unknown error';
}
