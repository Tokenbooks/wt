import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as os from 'node:os';

const CACHE_PATH = path.join(os.homedir(), '.cache', 'wt-update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;

interface CacheData {
  latest: string;
  checkedAt: number;
}

/**
 * Compare two semver-like version strings (e.g. "0.1.4" vs "0.2.0").
 * Returns true if b is newer than a.
 */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (nb > na) return true;
    if (nb < na) return false;
  }
  return false;
}

/**
 * Synchronously read the update cache and return a version notice string.
 * Returns a multi-line update notice if a newer version is available,
 * or a simple version line otherwise.
 */
export function getUpdateNotice(currentVersion: string): string {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const cache: CacheData = JSON.parse(raw);
    if (cache.latest && isNewer(currentVersion, cache.latest)) {
      return `wt v${currentVersion} — update available: ${cache.latest}\nRun: pnpm add -g @tokenbooks/wt`;
    }
  } catch {
    // Cache missing or corrupt — fall through
  }
  return `wt v${currentVersion}`;
}

/**
 * Fetch the latest version from the npm registry and write it to the cache.
 * Fire-and-forget — all errors are silently swallowed.
 */
export function refreshUpdateCache(packageName: string): void {
  const url = `https://registry.npmjs.org/${packageName}/latest`;

  const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    res.on('end', () => {
      try {
        const data = JSON.parse(body) as { version?: string };
        if (!data.version) return;

        const cache: CacheData = {
          latest: data.version,
          checkedAt: Date.now(),
        };

        const dir = path.dirname(CACHE_PATH);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache) + '\n');
      } catch {
        // Silently swallow JSON/write errors
      }
    });
  });

  req.on('error', () => {
    // Silently swallow network errors
  });
  req.on('timeout', () => {
    req.destroy();
  });
}

/**
 * Check whether the cache is fresh (less than TTL old).
 * Used to skip redundant registry fetches.
 */
export function isCacheFresh(): boolean {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const cache: CacheData = JSON.parse(raw);
    return Date.now() - cache.checkedAt < CACHE_TTL_MS;
  } catch {
    return false;
  }
}
