import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import * as child_process from 'node:child_process';

// Mock execSync to avoid real git calls in unit tests
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockExecSync = child_process.execSync as jest.MockedFunction<
  typeof child_process.execSync
>;

import {
  createWorktree,
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
  });
});
