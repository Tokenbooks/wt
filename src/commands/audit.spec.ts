import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
}));

jest.mock('../core/registry', () => ({
  readRegistry: jest.fn(),
}));

jest.mock('../core/audit', () => {
  const actual = jest.requireActual('../core/audit') as object;
  return {
    ...actual,
    resolveBaseRef: jest.fn(),
    fetchBaseRef: jest.fn(),
    loadPrStates: jest.fn(),
    auditWorktrees: jest.fn(),
  };
});

import { getMainWorktreePath } from '../core/git';
import { readRegistry } from '../core/registry';
import { auditWorktrees, fetchBaseRef, loadPrStates, resolveBaseRef, type WorktreeAudit } from '../core/audit';
import { auditCommand } from './audit';
import type { Registry } from '../types';

const mockGetMainWorktreePath = getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockReadRegistry = readRegistry as jest.MockedFunction<typeof readRegistry>;
const mockResolveBaseRef = resolveBaseRef as jest.MockedFunction<typeof resolveBaseRef>;
const mockFetchBaseRef = fetchBaseRef as jest.MockedFunction<typeof fetchBaseRef>;
const mockLoadPrStates = loadPrStates as jest.MockedFunction<typeof loadPrStates>;
const mockAuditWorktrees = auditWorktrees as jest.MockedFunction<typeof auditWorktrees>;

function auditOf(slot: number, verdict: WorktreeAudit['verdict']): WorktreeAudit {
  return {
    slot,
    path: `/repo/.worktrees/wt${slot}`,
    branch: `feat/${slot}`,
    dbName: `app_wt${slot}`,
    mergeMethod: verdict === 'delete-merged' ? 'ancestor' : null,
    containedIn: [],
    realDirty: [],
    onRemote: false,
    locked: false,
    lockedReason: '',
    pr: null,
    verdict,
    reason: '',
  };
}

describe('auditCommand', () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetMainWorktreePath.mockReturnValue('/repo');
    mockReadRegistry.mockReturnValue({
      version: 1,
      allocations: {
        '1': { worktreePath: '/repo/.worktrees/wt1', branchName: 'feat/1', dbName: 'app_wt1', ports: {}, createdAt: '2026-06-01T00:00:00.000Z' },
        '2': { worktreePath: '/repo/.worktrees/wt2', branchName: 'feat/2', dbName: 'app_wt2', ports: {}, createdAt: '2026-06-01T00:00:00.000Z' },
      },
    } satisfies Registry);
    mockResolveBaseRef.mockReturnValue('origin/main');
    mockLoadPrStates.mockReturnValue(new Map());
    mockAuditWorktrees.mockReturnValue([auditOf(1, 'delete-merged'), auditOf(2, 'keep-wip')]);
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('passes registry slots and the resolved base to the auditor', () => {
    auditCommand({ json: true, fetch: true, ignoreDirty: [] });

    expect(mockAuditWorktrees).toHaveBeenCalledTimes(1);
    const [slots, deps] = mockAuditWorktrees.mock.calls[0]!;
    expect(slots).toEqual([
      { slot: 1, path: '/repo/.worktrees/wt1', branch: 'feat/1', dbName: 'app_wt1' },
      { slot: 2, path: '/repo/.worktrees/wt2', branch: 'feat/2', dbName: 'app_wt2' },
    ]);
    expect(deps.base).toBe('origin/main');
    expect(deps.repoDir).toBe('/repo');
  });

  it('renders a human report containing the copyable remove command', () => {
    auditCommand({ json: false, fetch: true, ignoreDirty: [] });

    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('wt remove 1');
    expect(output).toContain('VERDICT');
  });

  it('emits the audits as JSON when --json is set', () => {
    auditCommand({ json: true, fetch: true, ignoreDirty: [] });

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string) as {
      success: boolean;
      data: WorktreeAudit[];
    };
    expect(output.success).toBe(true);
    expect(output.data.map((a) => a.slot)).toEqual([1, 2]);
    expect(output.data[0]?.verdict).toBe('delete-merged');
  });

  it('skips the network fetch when fetch is disabled', () => {
    auditCommand({ json: true, fetch: false, ignoreDirty: [] });
    expect(mockFetchBaseRef).not.toHaveBeenCalled();
  });

  it('honors an explicit base override instead of resolving', () => {
    auditCommand({ json: true, fetch: false, base: 'origin/develop', ignoreDirty: [] });
    expect(mockResolveBaseRef).not.toHaveBeenCalled();
    expect(mockAuditWorktrees.mock.calls[0]![1].base).toBe('origin/develop');
  });
});
