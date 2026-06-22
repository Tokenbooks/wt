import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  auditWorktrees,
  containingBranches,
  deletableSlots,
  findDeletableWorktrees,
  mergeMethod,
  realDirtyLines,
  resolveBaseRef,
  type WtSlot,
} from './audit';

/** Run a git command in a repo, returning trimmed stdout. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Commit a file change, creating an isolated commit. */
function commit(dir: string, file: string, contents: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), contents);
  git(['add', '.'], dir);
  git(['commit', '-m', message], dir);
}

/** Create a throwaway git repo with one commit on `main`. */
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-audit-git-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  commit(dir, 'README.md', 'init\n', 'init');
  return dir;
}

describe('mergeMethod (real git)', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'ancestor' when the branch tip is reachable from the base", () => {
    git(['checkout', '-b', 'feat/done'], dir);
    commit(dir, 'a.txt', 'a\n', 'feat work');
    git(['checkout', 'main'], dir);
    git(['merge', '--no-ff', '-m', 'merge feat', 'feat/done'], dir);

    expect(mergeMethod('feat/done', 'main', dir)).toBe('ancestor');
  });

  it("returns 'squash' when the branch's net diff was squash-merged into the base", () => {
    git(['checkout', '-b', 'feat/squashed'], dir);
    commit(dir, 'b.txt', 'first\n', 'b1');
    commit(dir, 'b.txt', 'first\nsecond\n', 'b2');
    git(['checkout', 'main'], dir);
    git(['merge', '--squash', 'feat/squashed'], dir);
    git(['commit', '-m', 'squash feat/squashed'], dir);

    expect(mergeMethod('feat/squashed', 'main', dir)).toBe('squash');
  });

  it('returns null when the branch has unmerged commits diverging from the base', () => {
    git(['checkout', '-b', 'feat/wip'], dir);
    commit(dir, 'c.txt', 'c\n', 'wip work');
    git(['checkout', 'main'], dir);
    commit(dir, 'd.txt', 'd\n', 'other main work');

    expect(mergeMethod('feat/wip', 'main', dir)).toBeNull();
  });
});

describe('containingBranches (real git)', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists another local branch that contains the tip, excluding main and self', () => {
    git(['checkout', '-b', 'feat/child'], dir);
    commit(dir, 'e.txt', 'e\n', 'child work');
    // 'feat/parent' is branched from child's tip, so it contains the child tip.
    git(['checkout', '-b', 'feat/parent'], dir);

    expect(containingBranches('feat/child', dir)).toEqual(['feat/parent']);
  });
});

describe('realDirtyLines (real git)', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports uncommitted changes', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');

    expect(realDirtyLines(dir, []).length).toBe(2);
  });

  it('filters out ignored noise paths', () => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'real.txt'), 'real\n');

    const dirty = realDirtyLines(dir, ['.mcp.json']);
    expect(dirty.length).toBe(1);
    expect(dirty[0]).toContain('real.txt');
  });

  it('returns an empty list for a clean worktree', () => {
    expect(realDirtyLines(dir, [])).toEqual([]);
  });
});

describe('resolveBaseRef (real git)', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to local main when no origin remote exists', () => {
    expect(resolveBaseRef(dir)).toBe('main');
  });
});

describe('auditWorktrees (real git, real worktrees)', () => {
  let dir: string;
  let wtMerged: string;
  let wtWip: string;

  beforeEach(() => {
    dir = initRepo();

    git(['checkout', '-b', 'feat/merged'], dir);
    commit(dir, 'merged.txt', 'm\n', 'merged work');
    git(['checkout', 'main'], dir);
    git(['merge', '--no-ff', '-m', 'merge feat/merged', 'feat/merged'], dir);

    git(['branch', 'feat/wip', 'main'], dir);
    git(['checkout', 'feat/wip'], dir);
    commit(dir, 'wip.txt', 'w\n', 'wip work');
    git(['checkout', 'main'], dir);

    wtMerged = path.join(dir, '..', `${path.basename(dir)}-merged`);
    wtWip = path.join(dir, '..', `${path.basename(dir)}-wip`);
    git(['worktree', 'add', wtMerged, 'feat/merged'], dir);
    git(['worktree', 'add', wtWip, 'feat/wip'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wtMerged, { recursive: true, force: true });
    fs.rmSync(wtWip, { recursive: true, force: true });
  });

  const slots = (): WtSlot[] => [
    { slot: 1, path: wtMerged, branch: 'feat/merged', dbName: 'db_wt1' },
    { slot: 2, path: wtWip, branch: 'feat/wip', dbName: 'db_wt2' },
  ];

  it('classifies a merged worktree deletable and an unmerged one keep-wip', () => {
    const audits = auditWorktrees(slots(), { repoDir: dir, base: 'main', ignoreDirtyPaths: [], prMap: new Map() });

    const bySlot = new Map(audits.map((a) => [a.slot, a]));
    expect(bySlot.get(1)?.verdict).toBe('delete-merged');
    expect(bySlot.get(2)?.verdict).toBe('keep-wip');
    expect(deletableSlots(audits)).toEqual([1]);
  });

  it('downgrades a merged worktree to review-uncommitted when it has dirty files', () => {
    fs.writeFileSync(path.join(wtMerged, 'scratch.txt'), 'dirty\n');

    const audits = auditWorktrees(slots(), { repoDir: dir, base: 'main', ignoreDirtyPaths: [], prMap: new Map() });

    expect(new Map(audits.map((a) => [a.slot, a])).get(1)?.verdict).toBe('review-uncommitted');
    expect(deletableSlots(audits)).toEqual([]);
  });

  it('findDeletableWorktrees returns only the merged, clean slot', () => {
    const deletable = findDeletableWorktrees(dir, slots(), { fetch: false, base: 'main' });
    expect(deletable.map((a) => a.slot)).toEqual([1]);
    expect(deletable[0]?.verdict).toBe('delete-merged');
  });

  it('findDeletableWorktrees excludes a merged slot that has uncommitted work', () => {
    fs.writeFileSync(path.join(wtMerged, 'scratch.txt'), 'dirty\n');
    const deletable = findDeletableWorktrees(dir, slots(), { fetch: false, base: 'main' });
    expect(deletable).toEqual([]);
  });
});
