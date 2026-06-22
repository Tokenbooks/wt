/**
 * Worktree audit: classify every wt-managed worktree by how its branch relates
 * to the base ref (`origin/main`), so the CLI can tell which trees are safe to
 * remove. Deletion safety is grounded in git, not in GitHub PR state: a PR can
 * be merged while the local branch keeps diverging past it, so the real question
 * is whether the branch tip already lives in the base ref (a merge or squash) or
 * has been folded into another retained local branch.
 *
 * The classification (`classify`) is pure over a gathered `WorktreeSignals`, so
 * the verdict matrix is fully unit-testable without touching git.
 */

import { execFileSync } from 'node:child_process';

/** Branches that are never themselves audit targets when testing reachability. */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/** GitHub PR lifecycle states surfaced by `gh pr list`. */
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** How a branch tip reaches the base ref, or `null` when it does not. */
export type MergeMethod = 'ancestor' | 'squash' | null;

/** The classification assigned to a worktree. */
export type Verdict =
  | 'delete-merged'
  | 'delete-consolidated'
  | 'keep-open-pr'
  | 'keep-wip'
  | 'review-uncommitted'
  | 'review-merged-diverged'
  | 'review-closed-pr';

/** One wt-managed slot, derived from the registry. */
export interface WtSlot {
  readonly slot: number;
  readonly path: string;
  readonly branch: string;
  readonly dbName: string;
}

/** Minimal PR descriptor for a branch. */
export interface PrInfo {
  readonly state: PrState;
  readonly number: number;
}

/** Signals gathered for a worktree before the verdict is assigned. */
export interface WorktreeSignals extends WtSlot {
  readonly mergeMethod: MergeMethod;
  readonly containedIn: string[];
  readonly realDirty: string[];
  readonly onRemote: boolean;
  readonly locked: boolean;
  readonly lockedReason: string;
  readonly pr: PrInfo | null;
}

/** The full audit result for a single worktree. */
export interface WorktreeAudit extends WorktreeSignals {
  readonly verdict: Verdict;
  readonly reason: string;
}

/** Short PR tag for a verdict reason, or an empty string when there is no PR. */
function prTag(pr: PrInfo | null): string {
  return pr ? ` (PR #${pr.number})` : '';
}

/** Classify a worktree from its raw signals, ignoring uncommitted state. */
function baseVerdict(audit: WorktreeSignals): { verdict: Verdict; reason: string } {
  if (audit.mergeMethod) {
    return { verdict: 'delete-merged', reason: `in base ref (${audit.mergeMethod})${prTag(audit.pr)}` };
  }
  if (audit.pr?.state === 'MERGED') {
    return audit.containedIn.length > 0
      ? { verdict: 'delete-consolidated', reason: `PR #${audit.pr.number} merged; folded into ${audit.containedIn[0]}` }
      : { verdict: 'review-merged-diverged', reason: `PR #${audit.pr.number} merged but local commits diverge from base` };
  }
  if (audit.containedIn.length > 0) {
    return { verdict: 'delete-consolidated', reason: `folded into ${audit.containedIn[0]}` };
  }
  if (audit.pr?.state === 'OPEN') {
    return { verdict: 'keep-open-pr', reason: `PR #${audit.pr.number} open` };
  }
  if (audit.pr?.state === 'CLOSED') {
    return { verdict: 'review-closed-pr', reason: `PR #${audit.pr.number} closed unmerged` };
  }
  return { verdict: 'keep-wip', reason: 'unmerged, no PR' };
}

/**
 * Final verdict: downgrade an otherwise-deletable tree that has real
 * uncommitted work so the audit never tells you to delete unsaved changes.
 */
export function classify(audit: WorktreeSignals): { verdict: Verdict; reason: string } {
  const base = baseVerdict(audit);
  const isDeletable = base.verdict === 'delete-merged' || base.verdict === 'delete-consolidated';
  if (isDeletable && audit.realDirty.length > 0) {
    return { verdict: 'review-uncommitted', reason: `${base.reason}; ${audit.realDirty.length} uncommitted file(s)` };
  }
  return base;
}

/** Slots whose verdict is unambiguously safe to delete, ascending. */
export function deletableSlots(audits: readonly WorktreeAudit[]): number[] {
  return audits
    .filter((a) => a.verdict === 'delete-merged' || a.verdict === 'delete-consolidated')
    .map((a) => a.slot)
    .sort((a, b) => a - b);
}

// --- git-backed signal gathering -------------------------------------------

/** Run `git` in a repo and return trimmed stdout, or `null` when it fails. */
function tryGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Run `git` for its exit status only, returning `true` on a zero exit. */
function gitOk(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine whether (and how) a branch tip already lives in the base ref:
 * `ancestor` when it is reachable directly, `squash` when its net diff was
 * squash-merged, or `null` when the work is not upstream.
 */
export function mergeMethod(branch: string, base: string, repoDir: string): MergeMethod {
  if (gitOk(['merge-base', '--is-ancestor', branch, base], repoDir)) {
    return 'ancestor';
  }
  return isSquashMerged(branch, base, repoDir) ? 'squash' : null;
}

/**
 * Detect a squash merge by synthesizing a single commit of the branch's net
 * diff atop its merge-base and asking `git cherry` whether that patch already
 * exists upstream. The synthesized commit is a dangling object with no ref; it
 * is reclaimed by `git gc` and never changes any branch.
 */
function isSquashMerged(branch: string, base: string, repoDir: string): boolean {
  const mergeBase = tryGit(['merge-base', base, branch], repoDir);
  const tree = tryGit(['rev-parse', `${branch}^{tree}`], repoDir);
  if (!mergeBase || !tree) {
    return false;
  }
  const squashCommit = tryGit(['commit-tree', tree, '-p', mergeBase, '-m', 'wt-audit-squash-probe'], repoDir);
  if (!squashCommit) {
    return false;
  }
  const cherry = tryGit(['cherry', base, squashCommit], repoDir);
  // `git cherry` prefixes an upstream-equivalent commit with '-' and a missing
  // one with '+', so a non-'+' line means the squashed diff is already merged.
  return cherry !== null && cherry.length > 0 && !cherry.startsWith('+');
}

/** List other local branches whose history contains this branch tip. */
export function containingBranches(branch: string, repoDir: string): string[] {
  const out = tryGit(['branch', '--contains', branch, '--format=%(refname:short)'], repoDir);
  if (!out) {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name !== branch && !PROTECTED_BRANCHES.has(name));
}

/** Report whether a branch tip is present on any remote-tracking branch. */
export function isOnRemote(branch: string, repoDir: string): boolean {
  const out = tryGit(['branch', '-r', '--contains', branch], repoDir);
  return out !== null && out.trim().length > 0;
}

/** List uncommitted changes in a worktree, excluding the configured noise paths. */
export function realDirtyLines(worktreePath: string, ignorePaths: readonly string[]): string[] {
  const out = tryGit(['status', '--porcelain'], worktreePath);
  if (!out) {
    return [];
  }
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !ignorePaths.some((ignored) => line.includes(ignored)));
}

/** Lock/prune flags parsed from `git worktree list --porcelain`. */
export interface WorktreeMeta {
  readonly locked: boolean;
  readonly lockedReason: string;
  readonly prunable: boolean;
}

/** One `gh pr list` row, narrowed to the fields the audit needs. */
export interface PrListRow {
  readonly number: number;
  readonly headRefName: string;
  readonly state: PrState;
}

/** Rank PR states so merged outranks open, and open outranks closed. */
function prRank(state: PrState): number {
  return state === 'MERGED' ? 2 : state === 'OPEN' ? 1 : 0;
}

/**
 * Reduce `gh pr list` rows to one PR per branch, keeping the most advanced
 * state so a merge outranks a later closed PR on the same branch.
 */
export function selectTopPrStates(rows: readonly PrListRow[]): Map<string, PrInfo> {
  const map = new Map<string, PrInfo>();
  for (const row of rows) {
    const existing = map.get(row.headRefName);
    if (!existing || prRank(row.state) > prRank(existing.state)) {
      map.set(row.headRefName, { state: row.state, number: row.number });
    }
  }
  return map;
}

/** Parse lock and prune flags for every worktree from porcelain output. */
export function parseWorktreeMeta(porcelain: string): Map<string, WorktreeMeta> {
  const map = new Map<string, WorktreeMeta>();
  let current: { locked: boolean; lockedReason: string; prunable: boolean } | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { locked: false, lockedReason: '', prunable: false };
      map.set(line.slice('worktree '.length), current);
    } else if (current && line.startsWith('locked')) {
      current.locked = true;
      current.lockedReason = line.slice('locked'.length).trim();
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return map;
}

/**
 * Resolve the base ref to audit against, preferring the remote-tracking ref so
 * the audit reflects what is actually on the remote.
 */
export function resolveBaseRef(repoDir: string, candidates: readonly string[] = ['origin/main', 'main']): string {
  for (const ref of candidates) {
    if (gitOk(['rev-parse', '--verify', '--quiet', ref], repoDir)) {
      return ref;
    }
  }
  throw new Error(`None of [${candidates.join(', ')}] resolve in ${repoDir}; cannot audit.`);
}

/** Load lock/prune metadata for every worktree from the main worktree. */
function loadWorktreeMeta(repoDir: string): Map<string, WorktreeMeta> {
  const out = tryGit(['worktree', 'list', '--porcelain'], repoDir);
  return out ? parseWorktreeMeta(out) : new Map();
}

/** Inputs shared across a single audit run. */
export interface AuditDeps {
  /** Main worktree directory, where the base ref and branches are resolved. */
  readonly repoDir: string;
  /** Resolved base ref, e.g. `origin/main`. */
  readonly base: string;
  /** Worktree-relative paths whose dirtiness is never real work. */
  readonly ignoreDirtyPaths: readonly string[];
  /** Branch → PR map (empty when `gh` is unavailable). */
  readonly prMap: Map<string, PrInfo>;
}

/** Audit a single slot by gathering its git, PR, and worktree signals. */
function auditSlot(slot: WtSlot, deps: AuditDeps, metaMap: Map<string, WorktreeMeta>): WorktreeAudit {
  const method = mergeMethod(slot.branch, deps.base, deps.repoDir);
  const meta = metaMap.get(slot.path);
  const signals: WorktreeSignals = {
    ...slot,
    mergeMethod: method,
    // A merged tip is already deletable, so skip the reachability scan.
    containedIn: method ? [] : containingBranches(slot.branch, deps.repoDir),
    realDirty: realDirtyLines(slot.path, deps.ignoreDirtyPaths),
    onRemote: isOnRemote(slot.branch, deps.repoDir),
    locked: meta?.locked ?? false,
    lockedReason: meta?.lockedReason ?? '',
    pr: deps.prMap.get(slot.branch) ?? null,
  };
  return { ...signals, ...classify(signals) };
}

/** Audit every wt-managed slot against the resolved base ref. */
export function auditWorktrees(slots: readonly WtSlot[], deps: AuditDeps): WorktreeAudit[] {
  const metaMap = loadWorktreeMeta(deps.repoDir);
  return slots.map((slot) => auditSlot(slot, deps, metaMap));
}

/** Best-effort refresh of `origin/main` so the audit reflects the remote. */
export function fetchBaseRef(repoDir: string): void {
  try {
    execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: repoDir, stdio: 'ignore' });
  } catch {
    process.stderr.write('wt audit: could not fetch origin/main; auditing the local ref.\n');
  }
}

/**
 * Build a branch → PR map from `gh`, returning an empty map when gh is absent.
 * PR context is advisory only; the audit still classifies from git history.
 */
export function loadPrStates(repoDir: string): Map<string, PrInfo> {
  let raw: string;
  try {
    raw = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '400', '--json', 'number,headRefName,state'],
      { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    process.stderr.write('wt audit: `gh` unavailable; classifying from git history only.\n');
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) {
    return new Map();
  }
  return selectTopPrStates(parsed.filter(isPrListRow));
}

/** Narrow an unknown value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard for a GitHub PR lifecycle state string. */
function isPrState(value: unknown): value is PrState {
  return value === 'OPEN' || value === 'CLOSED' || value === 'MERGED';
}

/** Type guard for a `gh pr list` row carrying the fields we need. */
function isPrListRow(value: unknown): value is PrListRow {
  return isRecord(value) && typeof value.number === 'number' && typeof value.headRefName === 'string' && isPrState(value.state);
}

// --- rendering -------------------------------------------------------------

/** Compact fixed-width label for a verdict in the table. */
function verdictLabel(verdict: Verdict): string {
  const labels: Record<Verdict, string> = {
    'delete-merged': 'DELETE (merged)',
    'delete-consolidated': 'DELETE (folded)',
    'keep-open-pr': 'keep (open PR)',
    'keep-wip': 'keep (WIP)',
    'review-uncommitted': 'REVIEW (dirty)',
    'review-merged-diverged': 'REVIEW (diverged)',
    'review-closed-pr': 'REVIEW (closed PR)',
  };
  return labels[verdict];
}

/** Three-letter PR cell for the table, or '-' when there is no PR. */
function prCell(pr: PrInfo | null): string {
  if (!pr) {
    return '-';
  }
  const abbrev = pr.state === 'MERGED' ? 'MRG' : pr.state === 'OPEN' ? 'OPN' : 'CLS';
  return `#${pr.number} ${abbrev}`;
}

/** Right-pad a string to a fixed width. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Truncate a string to a fixed width with an ellipsis. */
function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/** Render one aligned table row for a worktree. */
function renderRow(audit: WorktreeAudit): string {
  const cells = [
    pad(String(audit.slot), 4),
    pad(truncate(audit.branch, 44), 44),
    pad(audit.mergeMethod ?? '-', 9),
    pad(prCell(audit.pr), 11),
    pad(audit.realDirty.length > 0 ? String(audit.realDirty.length) : '-', 6),
    verdictLabel(audit.verdict),
  ];
  return cells.join(' ') + (audit.locked ? '  🔒' : '');
}

/** Build the per-verdict summary line. */
function renderSummary(audits: readonly WorktreeAudit[]): string {
  const counts = new Map<Verdict, number>();
  for (const audit of audits) {
    counts.set(audit.verdict, (counts.get(audit.verdict) ?? 0) + 1);
  }
  return [...counts.entries()].map(([verdict, count]) => `${verdictLabel(verdict)}: ${count}`).join('   ');
}

/** Build the commented "needs a decision" notes for review verdicts. */
function renderReviewNotes(audits: readonly WorktreeAudit[]): string[] {
  return audits
    .filter((a) => a.verdict.startsWith('review-'))
    .map((a) => `#   slot ${a.slot} ${truncate(a.branch, 40)} — ${a.reason}`);
}

/** Render the full human-readable audit report, including a copyable `wt remove`. */
export function renderReport(audits: readonly WorktreeAudit[], base: string): string {
  const columns = `${pad('SLOT', 4)} ${pad('BRANCH', 44)} ${pad('MERGE', 9)} ${pad('PR', 11)} ${pad('DIRTY', 6)} VERDICT`;
  const slots = deletableSlots(audits);
  const removeCommand = slots.length > 0 ? `wt remove ${slots.join(' ')}` : '# (nothing safe to delete)';
  const reviewNotes = renderReviewNotes(audits);
  return [
    `wt audit — ${audits.length} worktrees vs ${base}`,
    '',
    columns,
    '-'.repeat(columns.length),
    ...audits.map(renderRow),
    '',
    renderSummary(audits),
    '',
    '# Safe to remove (in base ref, or folded into a retained branch; no uncommitted work):',
    removeCommand,
    ...(reviewNotes.length > 0 ? ['', '# Needs a decision first:', ...reviewNotes] : []),
    '',
  ].join('\n');
}
