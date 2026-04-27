import { describe, expect, it } from '@jest/globals';
import { extractErrorMessage, formatRepairPreview } from '../src/output';

describe('extractErrorMessage', () => {
  it('extracts message from a regular Error', () => {
    expect(extractErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('handles non-Error values', () => {
    expect(extractErrorMessage('raw string')).toBe('raw string');
    expect(extractErrorMessage(42)).toBe('42');
  });

  it('extracts inner messages from AggregateError', () => {
    const agg = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
    );
    const msg = extractErrorMessage(agg);
    expect(msg).toContain('ECONNREFUSED ::1:5432');
    expect(msg).toContain('ECONNREFUSED 127.0.0.1:5432');
  });

  it('falls back to inner messages when AggregateError.message is empty', () => {
    const agg = new AggregateError([new Error('real error')], '');
    const msg = extractErrorMessage(agg);
    expect(msg).toBe('real error');
  });

  it('uses AggregateError.message when inner errors have no messages', () => {
    const agg = new AggregateError([new Error('')], 'outer message');
    const msg = extractErrorMessage(agg);
    expect(msg).toBe('outer message');
  });

  it('falls back to stderr for child-process-like errors', () => {
    const err = new Error('');
    (err as unknown as { stderr: string }).stderr = 'fatal: not a git repo';
    expect(extractErrorMessage(err)).toBe('fatal: not a git repo');
  });

  it('produces a non-empty message for an Error with empty message', () => {
    const err = new Error('');
    const msg = extractErrorMessage(err);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('returns Unknown error for null/undefined', () => {
    expect(extractErrorMessage(null)).toBe('null');
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  describe('formatRepairPreview', () => {
    it('renders unchanged services and one repaired service', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [
          { service: 'app', registered: 5000, proposed: 5005, reason: 'in use by python3[12345]' },
          { service: 'server', registered: 5001, proposed: 5001, reason: 'unchanged' },
        ],
        recreatedDockerServices: ['redis'],
        dryRun: true,
      });

      expect(text).toContain('Repair preview for slot 20 (cryptoacc_wt20):');
      expect(text).toContain('app');
      expect(text).toContain('5000 → 5005');
      expect(text).toContain('in use by python3[12345]');
      expect(text).toContain('server');
      expect(text).toContain('(unchanged)');
      expect(text).toContain('Docker services to recreate: redis');
      expect(text).toContain('[dry-run] No changes written');
    });

    it('renders an apply-mode preview without the [dry-run] line', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [{ service: 'app', registered: 5000, proposed: 5005, reason: 'in use by node[1]' }],
        recreatedDockerServices: [],
        dryRun: false,
      });

      expect(text).not.toContain('[dry-run]');
    });

    it('renders the "no changes needed" form when nothing changed and no docker recreate', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [
          { service: 'app', registered: 5000, proposed: 5000, reason: 'unchanged' },
        ],
        recreatedDockerServices: [],
        dryRun: false,
      });

      expect(text).toContain('Repair check for slot 20: no changes needed.');
    });
  });
});
