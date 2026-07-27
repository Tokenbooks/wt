import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findEnclosingCheckout, rewriteEnvPaths } from './env-paths';
import type { EnvPathRoots } from './env-paths';

/**
 * Build a main checkout with a sibling worktree, both marked as git working
 * trees the way git itself marks them: a `.git` directory in the primary
 * checkout and a `.git` file in the linked worktree.
 */
function createCheckoutFixture(tmpDir: string): EnvPathRoots {
  const mainRoot = path.join(tmpDir, 'proj');
  const worktreesDir = path.join(mainRoot, '.worktrees');
  const worktreeRoot = path.join(worktreesDir, 'my-branch');

  fs.mkdirSync(path.join(mainRoot, '.git'), { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: /elsewhere\n', 'utf-8');

  return { mainRoot, worktreeRoot, worktreesDir };
}

describe('findEnclosingCheckout', () => {
  let tmpDir: string;
  let roots: EnvPathRoots;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-paths-find-')));
    roots = createCheckoutFixture(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the checkout root for a path that does not exist yet', () => {
    // Arrange
    const unbuilt = path.join(roots.mainRoot, 'apps/runner/target/release/runner');

    // Act
    const checkout = findEnclosingCheckout(unbuilt);

    // Assert
    expect(checkout).toBe(roots.mainRoot);
  });

  it('finds the nearest checkout, so a worktree wins over the main root above it', () => {
    // Arrange
    const inWorktree = path.join(roots.worktreeRoot, 'apps/runner/target/release/runner');

    // Act
    const checkout = findEnclosingCheckout(inWorktree);

    // Assert
    expect(checkout).toBe(roots.worktreeRoot);
  });

  it('never attributes a path outside the checkouts to one of them', () => {
    // Arrange: the ancestors of a temp dir are shared with the machine, so this
    // asserts the attribution rather than the absence of any checkout at all.
    const outside = path.join(tmpDir, 'not-a-repo/bin/tool');

    // Act
    const checkout = findEnclosingCheckout(outside);

    // Assert
    expect(checkout).not.toBe(roots.mainRoot);
    expect(checkout).not.toBe(roots.worktreeRoot);
  });

  it('returns undefined when no ancestor is a checkout', () => {
    // Act
    const checkout = findEnclosingCheckout(path.parse(tmpDir).root);

    // Assert
    expect(checkout).toBeUndefined();
  });
});

describe('rewriteEnvPaths', () => {
  let tmpDir: string;
  let roots: EnvPathRoots;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-paths-')));
    roots = createCheckoutFixture(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('repoints a path into the main checkout at the same place in the worktree', () => {
    // Arrange
    const mainBinary = path.join(roots.mainRoot, 'apps/runner/target/release/runner');
    const content = `RUNNER_BIN=${mainBinary}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    const worktreeBinary = path.join(roots.worktreeRoot, 'apps/runner/target/release/runner');
    expect(result.content).toBe(`RUNNER_BIN=${worktreeBinary}\n`);
    expect(result.escapes).toEqual([
      {
        file: 'server/.env',
        varName: 'RUNNER_BIN',
        value: mainBinary,
        rewritten: worktreeBinary,
      },
    ]);
  });

  it('repoints a path into a sibling worktree rather than nesting it', () => {
    // Arrange
    const sibling = path.join(roots.worktreesDir, 'other-branch');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, '.git'), 'gitdir: /elsewhere\n', 'utf-8');
    const content = `RUNNER_BIN=${path.join(sibling, 'apps/runner/bin')}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN=${path.join(roots.worktreeRoot, 'apps/runner/bin')}\n`,
    );
  });

  it('reports a path into an unrelated checkout without rewriting it', () => {
    // Arrange
    const foreignRoot = path.join(tmpDir, 'other-project');
    fs.mkdirSync(path.join(foreignRoot, '.git'), { recursive: true });
    const foreignBinary = path.join(foreignRoot, 'bin/tool');
    const content = `TOOL_BIN=${foreignBinary}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(content);
    expect(result.escapes).toEqual([
      { file: 'server/.env', varName: 'TOOL_BIN', value: foreignBinary, rewritten: undefined },
    ]);
  });

  it('leaves a path that already points inside this worktree alone', () => {
    // Arrange
    const inside = path.join(roots.worktreeRoot, 'apps/runner/bin');
    const content = `RUNNER_BIN=${inside}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(content);
    expect(result.escapes).toEqual([]);
  });

  it.each([
    ['a shared system path', 'NODE_BIN=/usr/bin/node'],
    ['a relative path', 'RUNNER_BIN=../apps/runner/target/release/runner'],
    ['a database url', 'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp'],
    ['a comment', '# RUNNER_BIN=/usr/bin/node'],
    ['a blank line', ''],
  ])('leaves %s untouched and unreported', (_label, line) => {
    // Arrange
    const content = `${line}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(content);
    expect(result.escapes).toEqual([]);
  });

  it('preserves an export prefix and surrounding quotes', () => {
    // Arrange
    const mainBinary = path.join(roots.mainRoot, 'apps/runner/bin');
    const content = `export RUNNER_BIN="${mainBinary}"\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `export RUNNER_BIN="${path.join(roots.worktreeRoot, 'apps/runner/bin')}"\n`,
    );
  });

  it('expands a leading tilde before deciding, and writes back an absolute path', () => {
    // Arrange: spell the same main-checkout path relative to the home directory.
    const homeRelative = path.relative(os.homedir(), roots.mainRoot);
    const content = `RUNNER_BIN=~/${path.join(homeRelative, 'apps/runner/bin')}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN=${path.join(roots.worktreeRoot, 'apps/runner/bin')}\n`,
    );
  });

  it('rewrites the path but leaves an inline comment byte-for-byte', () => {
    // Arrange
    const mainBinary = path.join(roots.mainRoot, 'apps/runner/bin');
    const content = `RUNNER_BIN=${mainBinary} # see https://example.com/build\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN=${path.join(roots.worktreeRoot, 'apps/runner/bin')} # see https://example.com/build\n`,
    );
    expect(result.escapes[0]?.value).toBe(mainBinary);
  });

  it('keeps quotes balanced when text follows the closing quote', () => {
    // Arrange
    const content = `RUNNER_BIN="${path.join(roots.mainRoot, 'apps/runner/bin')}"  \n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN="${path.join(roots.worktreeRoot, 'apps/runner/bin')}"  \n`,
    );
    expect(result.content.match(/"/g)).toHaveLength(2);
  });

  it('rewrites a value on a CRLF line and keeps the carriage return', () => {
    // Arrange
    const content = `RUNNER_BIN=${path.join(roots.mainRoot, 'apps/runner/bin')}\r\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN=${path.join(roots.worktreeRoot, 'apps/runner/bin')}\r\n`,
    );
  });

  it.each([
    ['an unterminated quote', (root: string) => `RUNNER_BIN="${path.join(root, 'apps/runner/bin')}\n`],
    ['a colon-joined path list', (root: string) => `PATHS=${path.join(root, 'bin')}:${path.join(root, 'lib')}\n`],
  ])('leaves %s entirely alone rather than repairing it partly', (_label, build) => {
    // Arrange
    const content = build(roots.mainRoot);

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(content);
    expect(result.escapes).toEqual([]);
  });

  it('recognises the main checkout through a symlinked spelling', () => {
    // Arrange
    const linkedRoot = path.join(tmpDir, 'link-to-proj');
    fs.symlinkSync(roots.mainRoot, linkedRoot);
    const content = `RUNNER_BIN=${path.join(linkedRoot, 'apps/runner/bin')}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    expect(result.content).toBe(
      `RUNNER_BIN=${path.join(roots.worktreeRoot, 'apps/runner/bin')}\n`,
    );
  });

  it('produces the same result when run a second time', () => {
    // Arrange
    const content = `RUNNER_BIN=${path.join(roots.mainRoot, 'apps/runner/bin')}\n`;

    // Act
    const once = rewriteEnvPaths(content, 'server/.env', roots);
    const twice = rewriteEnvPaths(once.content, 'server/.env', roots);

    // Assert
    expect(twice.content).toBe(once.content);
    expect(twice.escapes).toEqual([]);
  });

  it('rewrites a path to an artifact the worktree has not built yet', () => {
    // Arrange
    const builtInMain = path.join(roots.mainRoot, 'apps/runner/target/release/runner');
    fs.mkdirSync(path.dirname(builtInMain), { recursive: true });
    fs.writeFileSync(builtInMain, 'binary', 'utf-8');
    const content = `RUNNER_BIN=${builtInMain}\n`;

    // Act
    const result = rewriteEnvPaths(content, 'server/.env', roots);

    // Assert
    const worktreeBinary = path.join(roots.worktreeRoot, 'apps/runner/target/release/runner');
    expect(fs.existsSync(worktreeBinary)).toBe(false);
    expect(result.content).toBe(`RUNNER_BIN=${worktreeBinary}\n`);
  });
});
