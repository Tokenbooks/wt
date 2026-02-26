import { execSync } from 'node:child_process';
import * as path from 'node:path';

type CommandLogger = (command: string) => void;

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
 * If the branch already exists, checks it out; otherwise creates it with -b.
 */
export function createWorktree(
  basePath: string,
  branchName: string,
  logCommand?: CommandLogger,
): string {
  const slug = branchName.replace(/\//g, '-');
  const worktreePath = path.resolve(basePath, slug);

  const branchExists = branchExistsLocally(branchName);
  const args = branchExists
    ? `"${worktreePath}" "${branchName}"`
    : `"${worktreePath}" -b "${branchName}"`;

  const command = `git worktree add ${args}`;
  logCommand?.(command);
  execSync(command, { stdio: 'pipe' });
  return worktreePath;
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
