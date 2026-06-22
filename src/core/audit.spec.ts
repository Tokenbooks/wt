import { describe, expect, it } from '@jest/globals';
import {
  classify,
  deletableSlots,
  parseWorktreeMeta,
  renderReport,
  selectTopPrStates,
  type WorktreeAudit,
  type WorktreeSignals,
} from './audit';

/** Build a complete signals object, overriding only what a test cares about. */
function signals(overrides: Partial<WorktreeSignals> = {}): WorktreeSignals {
  return {
    slot: 1,
    path: '/repo/.worktrees/feat-x',
    branch: 'feat/x',
    dbName: 'app_wt1',
    mergeMethod: null,
    containedIn: [],
    realDirty: [],
    onRemote: false,
    locked: false,
    lockedReason: '',
    pr: null,
    ...overrides,
  };
}

describe('classify', () => {
  it('marks a tip reachable from the base ref as delete-merged', () => {
    expect(classify(signals({ mergeMethod: 'ancestor' })).verdict).toBe('delete-merged');
  });

  it('marks a squash-merged tip as delete-merged and names the method', () => {
    const result = classify(signals({ mergeMethod: 'squash' }));
    expect(result.verdict).toBe('delete-merged');
    expect(result.reason).toContain('squash');
  });

  it('treats a merged PR folded into another branch as delete-consolidated', () => {
    const result = classify(signals({ pr: { state: 'MERGED', number: 42 }, containedIn: ['feat/parent'] }));
    expect(result.verdict).toBe('delete-consolidated');
    expect(result.reason).toContain('feat/parent');
  });

  it('flags a merged PR that still diverges from main as review-merged-diverged', () => {
    expect(classify(signals({ pr: { state: 'MERGED', number: 7 } })).verdict).toBe('review-merged-diverged');
  });

  it('treats a tip folded into a retained branch (no PR) as delete-consolidated', () => {
    expect(classify(signals({ containedIn: ['feat/parent'] })).verdict).toBe('delete-consolidated');
  });

  it('keeps a branch with an open PR', () => {
    expect(classify(signals({ pr: { state: 'OPEN', number: 9 } })).verdict).toBe('keep-open-pr');
  });

  it('flags a closed unmerged PR as review-closed-pr so rejected work is not silently deleted', () => {
    expect(classify(signals({ pr: { state: 'CLOSED', number: 9 } })).verdict).toBe('review-closed-pr');
  });

  it('keeps an unmerged branch with no PR as keep-wip', () => {
    expect(classify(signals()).verdict).toBe('keep-wip');
  });

  it('downgrades an otherwise-deletable merged tree with uncommitted work to review-uncommitted', () => {
    const result = classify(signals({ mergeMethod: 'ancestor', realDirty: ['M src/x.ts'] }));
    expect(result.verdict).toBe('review-uncommitted');
    expect(result.reason).toContain('1 uncommitted');
  });

  it('downgrades a deletable consolidated tree with uncommitted work to review-uncommitted', () => {
    expect(classify(signals({ containedIn: ['feat/parent'], realDirty: ['M a', 'M b'] })).verdict).toBe('review-uncommitted');
  });

  it('does not downgrade keep-wip just because it is dirty', () => {
    expect(classify(signals({ realDirty: ['M src/x.ts'] })).verdict).toBe('keep-wip');
  });

  it('lets merge reachability win over a stale closed PR', () => {
    expect(classify(signals({ mergeMethod: 'ancestor', pr: { state: 'CLOSED', number: 3 } })).verdict).toBe('delete-merged');
  });
});

describe('deletableSlots', () => {
  const audit = (slot: number, verdict: WorktreeAudit['verdict']): WorktreeAudit => ({
    ...signals({ slot }),
    verdict,
    reason: '',
  });

  it('returns only delete-* slots, ascending', () => {
    const audits = [
      audit(3, 'delete-consolidated'),
      audit(1, 'delete-merged'),
      audit(2, 'keep-wip'),
      audit(5, 'review-uncommitted'),
    ];
    expect(deletableSlots(audits)).toEqual([1, 3]);
  });

  it('returns an empty list when nothing is safe to delete', () => {
    expect(deletableSlots([audit(1, 'keep-open-pr'), audit(2, 'review-closed-pr')])).toEqual([]);
  });
});

describe('selectTopPrStates', () => {
  it('lets a merged PR outrank a later closed PR on the same branch', () => {
    const map = selectTopPrStates([
      { number: 1, headRefName: 'feat/x', state: 'MERGED' },
      { number: 2, headRefName: 'feat/x', state: 'CLOSED' },
    ]);
    expect(map.get('feat/x')).toEqual({ state: 'MERGED', number: 1 });
  });

  it('lets an open PR outrank a closed one', () => {
    const map = selectTopPrStates([
      { number: 5, headRefName: 'feat/y', state: 'CLOSED' },
      { number: 6, headRefName: 'feat/y', state: 'OPEN' },
    ]);
    expect(map.get('feat/y')?.state).toBe('OPEN');
  });
});

describe('parseWorktreeMeta', () => {
  it('marks a worktree locked and captures its reason', () => {
    const porcelain = [
      'worktree /repo/.worktrees/a',
      'HEAD abc',
      'branch refs/heads/feat/a',
      'locked needs review',
      '',
      'worktree /repo/.worktrees/b',
      'HEAD def',
      'branch refs/heads/feat/b',
      '',
    ].join('\n');
    const map = parseWorktreeMeta(porcelain);
    expect(map.get('/repo/.worktrees/a')).toEqual({ locked: true, lockedReason: 'needs review', prunable: false });
    expect(map.get('/repo/.worktrees/b')?.locked).toBe(false);
  });
});

describe('renderReport', () => {
  const base = (overrides: Partial<WorktreeAudit>): WorktreeAudit => ({
    slot: 1,
    path: '/repo/.worktrees/x',
    branch: 'feat/x',
    dbName: 'app_wt1',
    mergeMethod: null,
    containedIn: [],
    realDirty: [],
    onRemote: false,
    locked: false,
    lockedReason: '',
    pr: null,
    verdict: 'keep-wip',
    reason: '',
    ...overrides,
  });

  it('emits a copyable wt remove command for deletable slots', () => {
    const report = renderReport(
      [
        base({ slot: 1, verdict: 'delete-merged', mergeMethod: 'ancestor' }),
        base({ slot: 3, verdict: 'delete-consolidated', containedIn: ['feat/p'] }),
        base({ slot: 2, verdict: 'keep-wip' }),
      ],
      'origin/main',
    );
    expect(report).toContain('wt remove 1 3');
  });

  it('says nothing is safe to delete when no slot qualifies', () => {
    const report = renderReport([base({ slot: 1, verdict: 'keep-open-pr', pr: { state: 'OPEN', number: 4 } })], 'origin/main');
    expect(report).toContain('nothing safe to delete');
    expect(report).not.toMatch(/wt remove \d/);
  });

  it('lists review verdicts under a needs-a-decision note', () => {
    const report = renderReport(
      [base({ slot: 2, branch: 'feat/closed', verdict: 'review-closed-pr', reason: 'PR #9 closed unmerged', pr: { state: 'CLOSED', number: 9 } })],
      'origin/main',
    );
    expect(report).toContain('Needs a decision');
    expect(report).toContain('feat/closed');
  });
});
