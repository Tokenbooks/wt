import { describe, expect, it } from '@jest/globals';
import { parseRemoveTargets } from './remove';

describe('remove command target parsing', () => {
  it('parses comma-separated slots', () => {
    expect(parseRemoveTargets(['1,2'])).toEqual(['1', '2']);
  });

  it('parses comma-separated slots with spaces', () => {
    expect(parseRemoveTargets(['1, 2'])).toEqual(['1', '2']);
  });

  it('parses mixed comma and variadic targets', () => {
    expect(parseRemoveTargets(['1, 2', '3'])).toEqual(['1', '2', '3']);
  });

  it('keeps single path targets untouched', () => {
    expect(parseRemoveTargets(['.worktrees/feat-auth'])).toEqual(['.worktrees/feat-auth']);
  });

  it('drops empty target fragments', () => {
    expect(parseRemoveTargets(['1,,2', ' , '])).toEqual(['1', '2']);
  });
});
