import { describe, it, expect, jest } from '@jest/globals';
import * as child_process from 'node:child_process';

// Mock execSync to avoid real git calls in unit tests
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockExecSync = child_process.execSync as jest.MockedFunction<
  typeof child_process.execSync
>;

import { getMainWorktreePath, isMainWorktree } from '../src/core/git';

describe('git', () => {
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
});
