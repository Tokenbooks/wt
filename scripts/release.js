const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const REPO_URL = 'https://github.com/tokenbooks/wt';

// --- helpers ---

function run(cmd, opts = {}) {
  const result = execSync(cmd, { encoding: 'utf8', cwd: path.join(__dirname, '..'), ...opts });
  return result == null ? '' : result.trim();
}

function die(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

function bumpVersion(current, part) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (part) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: die(`Unknown bump type: ${part}`);
  }
}

// --- parse args ---

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

const bumpType = positional[0] || 'patch';
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  die(`Invalid bump type "${bumpType}". Use patch, minor, or major.`);
}

const dryRun = flags.has('--dry-run');
const noPush = flags.has('--no-push');
const noBranchCheck = flags.has('--no-branch-check');

if (dryRun) console.log('DRY RUN — no changes will be made\n');

// --- validate git state ---

if (!noBranchCheck) {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') {
    die(`Must be on main branch (currently on "${branch}"). Use --no-branch-check to override.`);
  }
}

const status = run('git status --porcelain');
if (status) {
  die('Working directory is not clean. Commit or stash changes first.');
}

if (!noBranchCheck) {
  run('git fetch origin main --quiet');
  const local = run('git rev-parse HEAD');
  const remote = run('git rev-parse origin/main');
  if (local !== remote) {
    die('Local main is not up-to-date with origin. Pull or push first.');
  }
}

// --- compute version ---

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bumpType);

console.log(`Bump: ${oldVersion} → ${newVersion} (${bumpType})\n`);

// --- quality gates ---

console.log('Running quality gates...');
const gates = ['pnpm lint', 'pnpm test', 'pnpm build'];
for (const cmd of gates) {
  console.log(`  $ ${cmd}`);
  if (!dryRun) {
    try {
      run(cmd, { stdio: 'inherit' });
    } catch {
      die(`Quality gate failed: ${cmd}`);
    }
  }
}
console.log();

// --- bump version in package.json ---

console.log(`Writing version ${newVersion} to package.json`);
if (!dryRun) {
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

// --- commit & tag ---

const commitMsg = `chore(release): ${newVersion}`;
const tag = `v${newVersion}`;

console.log(`Committing: ${commitMsg}`);
console.log(`Tagging:    ${tag}\n`);
if (!dryRun) {
  run('git add package.json');
  run(`git commit -m "${commitMsg}"`);
  run(`git tag -a ${tag} -m "${commitMsg}"`);
}

// --- push ---

if (!noPush && !dryRun) {
  console.log('Pushing to origin...');
  run('git push origin main --follow-tags');
  console.log();
}

// --- done ---

if (dryRun) {
  console.log('Dry run complete. No changes were made.');
} else if (noPush) {
  console.log(`Release ${newVersion} committed and tagged locally.`);
  console.log(`Run "git push origin main --follow-tags" when ready.`);
} else {
  console.log(`Release ${newVersion} published!`);
  console.log(`CI: ${REPO_URL}/actions`);
}
