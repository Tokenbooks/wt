import { execSync } from 'node:child_process';
import * as path from 'node:path';

type CommandLogger = (command: string) => void;

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
 * Prefers a fresh local branch that tracks origin when the remote branch exists.
 */
export function resolveWorktreeBranch(
  branchName: string,
  logCommand?: CommandLogger,
): WorktreeBranchSelection {
  if (branchExistsLocally(branchName)) {
    return {
      branchName,
      source: 'local-existing',
      sourceLabel: 'existing local branch',
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
      originCheckError: extractCommandErrorMessage(err),
    };
  }

  return {
    branchName,
    source: 'local-new',
    sourceLabel: 'fresh local branch',
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
      return `git worktree add "${worktreePath}" -b "${branch.branchName}"`;
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
