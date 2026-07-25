import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import * as child_process from 'node:child_process';

// Mock the child_process entry points to avoid real git calls in unit tests
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));

// Pin the OS user so generated branch names do not depend on who runs the suite.
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  userInfo: () => ({ username: 'devuser' }),
}));

const mockExecSync = child_process.execSync as jest.MockedFunction<
  typeof child_process.execSync
>;
const mockExecFileSync = child_process.execFileSync as jest.MockedFunction<
  typeof child_process.execFileSync
>;

import {
  assertRefExists,
  createWorktree,
  deleteBranch,
  generateAutoBranchName,
  getMainWorktreePath,
  isMainWorktree,
  listPrunableWorktrees,
  pruneWorktrees,
  resolveWorktreeBranch,
} from '../src/core/git';

describe('git', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMainWorktreePath', () => {
    it('parses the first worktree from porcelain output', () => {
      // Arrange
      mockExecSync.mockReturnValue(
        'worktree /Users/dev/project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /Users/dev/.worktrees/feat\n',
      );

      // Act
      const result = getMainWorktreePath();

      // Assert
      expect(result).toBe('/Users/dev/project');
    });

    it('throws if output is unexpected', () => {
      // Arrange
      mockExecSync.mockReturnValue('');

      // Act & Assert
      expect(() => getMainWorktreePath()).toThrow('Could not determine main worktree path');
    });
  });

  describe('isMainWorktree', () => {
    it('returns true for the main worktree path', () => {
      // Arrange
      mockExecSync.mockReturnValue('worktree /Users/dev/project\n');

      // Act & Assert
      expect(isMainWorktree('/Users/dev/project')).toBe(true);
    });

    it('returns false for a secondary worktree path', () => {
      // Arrange
      mockExecSync.mockReturnValue('worktree /Users/dev/project\n');

      // Act & Assert
      expect(isMainWorktree('/Users/dev/.worktrees/feat')).toBe(false);
    });
  });

  describe('listPrunableWorktrees', () => {
    it('returns only worktrees marked as prunable in porcelain output', () => {
      mockExecSync.mockReturnValue(
        [
          'worktree /Users/dev/project',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /Users/dev/project/.worktrees/feat',
          'HEAD def456',
          'branch refs/heads/feat',
          'prunable gitdir file points to non-existent location',
          '',
          'worktree /Users/dev/project/.worktrees/other',
          'HEAD 012345',
          'branch refs/heads/other',
          '',
        ].join('\n'),
      );

      expect(listPrunableWorktrees()).toEqual([
        {
          path: '/Users/dev/project/.worktrees/feat',
          reason: 'gitdir file points to non-existent location',
        },
      ]);
    });
  });

  describe('pruneWorktrees', () => {
    it('runs git worktree prune with verbose logging', () => {
      pruneWorktrees();

      expect(mockExecSync).toHaveBeenCalledWith('git worktree prune --verbose', { stdio: 'pipe' });
    });
  });

  describe('resolveWorktreeBranch', () => {
    it('fetches and uses origin when the branch only exists remotely', () => {
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('missing local branch');
        })
        .mockReturnValueOnce('abc123\trefs/heads/feat/auth\n')
        .mockReturnValueOnce('');

      expect(resolveWorktreeBranch('feat/auth')).toEqual({
        branchName: 'feat/auth',
        source: 'origin',
        sourceLabel: 'origin/feat/auth',
        startPoint: 'origin/feat/auth',
      });

      expect(mockExecSync).toHaveBeenNthCalledWith(
        2,
        'git ls-remote --exit-code --heads origin "feat/auth"',
        {
          encoding: 'utf-8',
          stdio: 'pipe',
        },
      );
      expect(mockExecSync).toHaveBeenNthCalledWith(
        3,
        'git fetch origin "refs/heads/feat/auth:refs/remotes/origin/feat/auth"',
        { stdio: 'pipe' },
      );
    });

    it('falls back to a fresh local branch when origin lookup fails', () => {
      const originError = Object.assign(new Error('Could not resolve host'), {
        status: 128,
        stderr: 'fatal: Could not resolve host',
      });

      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('missing local branch');
        })
        .mockImplementationOnce(() => {
          throw originError;
        });

      expect(resolveWorktreeBranch('feat/auth')).toEqual({
        branchName: 'feat/auth',
        source: 'local-new',
        sourceLabel: 'fresh local branch',
        originCheckError: 'fatal: Could not resolve host',
      });
    });

    it('records the base as the start point for a fresh local branch', () => {
      // local miss, then origin miss (exit 2) -> fresh local branch off the base.
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('missing local branch');
        })
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('no remote branch'), { status: 2 });
        });

      expect(resolveWorktreeBranch('feat/auth', undefined, { base: 'main' })).toEqual({
        branchName: 'feat/auth',
        source: 'local-new',
        sourceLabel: 'fresh local branch',
        startPoint: 'main',
      });
    });

    it('skips the origin lookup entirely for a name wt invented', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('missing local branch');
      });

      expect(
        resolveWorktreeBranch('main-20260723-devuser', undefined, {
          base: 'origin/main',
          skipOriginLookup: true,
        }),
      ).toEqual({
        branchName: 'main-20260723-devuser',
        source: 'local-new',
        sourceLabel: 'fresh local branch',
        startPoint: 'origin/main',
      });
      // Only the local probe ran: no ls-remote, no fetch.
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it('leaves the base inert when the branch already exists locally', () => {
      mockExecSync.mockReturnValueOnce('abc123\n'); // rev-parse succeeds -> exists

      expect(resolveWorktreeBranch('feat/auth', undefined, { base: 'main' })).toEqual({
        branchName: 'feat/auth',
        source: 'local-existing',
        sourceLabel: 'existing local branch',
      });
    });
  });

  describe('createWorktree', () => {
    it('tracks the remote branch when origin is selected', () => {
      createWorktree('/Users/dev/project/.worktrees', {
        branchName: 'feat/auth',
        source: 'origin',
        sourceLabel: 'origin/feat/auth',
        startPoint: 'origin/feat/auth',
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        'git worktree add "/Users/dev/project/.worktrees/feat-auth" --track -b "feat/auth" "origin/feat/auth"',
        { stdio: 'pipe' },
      );
    });

    it('creates a fresh local branch when requested', () => {
      createWorktree('/Users/dev/project/.worktrees', {
        branchName: 'feat/auth',
        source: 'local-new',
        sourceLabel: 'fresh local branch',
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        'git worktree add "/Users/dev/project/.worktrees/feat-auth" -b "feat/auth"',
        { stdio: 'pipe' },
      );
    });

    it('forks a fresh local branch from the start point when a base is set', () => {
      createWorktree('/Users/dev/project/.worktrees', {
        branchName: 'feat/auth',
        source: 'local-new',
        sourceLabel: 'fresh local branch',
        startPoint: 'main',
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        'git worktree add "/Users/dev/project/.worktrees/feat-auth" -b "feat/auth" "main"',
        { stdio: 'pipe' },
      );
    });
  });

  describe('generateAutoBranchName', () => {
    it('builds a base-date-user name and strips a leading origin/', () => {
      // Every branchExistsLocally probe reports "missing" so the first candidate wins.
      mockExecSync.mockImplementation(() => {
        throw new Error('missing');
      });

      const name = generateAutoBranchName('origin/main');

      expect(name).toMatch(/^main-\d{8}-devuser$/);
      expect(name).not.toContain('/');
    });

    it('reduces a base ref to a name git will accept', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('missing');
      });

      expect(generateAutoBranchName('release/2.0')).toMatch(/^release-2\.0-\d{8}-devuser$/);
      // `~` and `@{}` are legal in a revision but not in a branch name.
      expect(generateAutoBranchName('HEAD~2')).toMatch(/^HEAD-2-\d{8}-devuser$/);
      expect(generateAutoBranchName('main@{upstream}')).toMatch(/^main-upstream-\d{8}-devuser$/);
    });

    it('appends a numeric suffix when the candidate already exists', () => {
      // Every probe reports "missing"...
      mockExecSync.mockImplementation(() => {
        throw new Error('missing');
      });
      // ...except the first, so the initial candidate collides and gets a `-2`.
      mockExecSync.mockReturnValueOnce('');

      expect(generateAutoBranchName('main')).toMatch(/^main-\d{8}-devuser-2$/);
    });
  });

  describe('assertRefExists', () => {
    it('does not throw when the ref resolves', () => {
      mockExecFileSync.mockReturnValue('abc123\n');
      expect(() => assertRefExists('main')).not.toThrow();
      // No shell: git receives the ref as an argument, never as command text.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', '--quiet', 'main^{commit}'],
        { stdio: 'pipe' },
      );
    });

    it('throws a clean error when the ref is missing', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('bad revision');
      });
      expect(() => assertRefExists('bogus')).toThrow("base ref 'bogus' not found");
    });
  });

  describe('deleteBranch', () => {
    it('refuses to force-delete, so unmerged commits survive', () => {
      mockExecSync.mockReturnValue('');

      deleteBranch('main-20260723-devuser');

      expect(mockExecSync).toHaveBeenCalledWith('git branch -d "main-20260723-devuser"', {
        stdio: 'pipe',
      });
    });
  });

  describe('ref safety', () => {
    it.each([
      'main"; touch /tmp/pwn; echo "',
      'main$(whoami)',
      'main`whoami`',
      'main\\"; touch /tmp/pwn; echo "',
      'main\nwhoami',
      '',
    ])('rejects the shell-unsafe ref %p before running git', (ref) => {
      expect(() => assertRefExists(ref)).toThrow('contains unsupported characters');
      expect(() => resolveWorktreeBranch(ref)).toThrow('contains unsupported characters');
      expect(() => resolveWorktreeBranch('feat/auth', undefined, { base: ref })).toThrow(
        'contains unsupported characters',
      );
      // The auto-name path reaches git before resolveWorktreeBranch does.
      expect(() => generateAutoBranchName(ref)).toThrow('contains unsupported characters');
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('still accepts ordinary branch, tag, and revision syntax', () => {
      mockExecFileSync.mockReturnValue('abc123\n');
      for (const ref of ['main', 'origin/main', 'feat/auth-2', 'v1.2.3', 'HEAD~2', 'a1b2c3d']) {
        expect(() => assertRefExists(ref)).not.toThrow();
      }
    });

    it('does not reject branch names git itself allows', () => {
      // Only shell-special characters are refused, so these keep working.
      mockExecFileSync.mockReturnValue('abc123\n');
      for (const ref of ['feat/\u00fcn\u00efcode', "fix/don't-panic", 'feat/a&b', 'release/1.0,rc']) {
        expect(() => assertRefExists(ref)).not.toThrow();
      }
    });
  });
});
