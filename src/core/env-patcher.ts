import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PatchConfig, PatchContext, WtConfig } from '../types';

/**
 * Apply a single patch to an env var value.
 * Returns the transformed value or the original if no transformation applies.
 */
function applyPatch(
  value: string,
  patch: PatchConfig,
  context: PatchContext,
): string {
  switch (patch.type) {
    case 'database':
      return patchDatabaseUrl(value, context.dbName);
    case 'redis':
      return patchRedisUrl(value, context.redisDb);
    case 'port':
      return patchPort(patch, context);
    case 'url':
      return patchUrlPort(value, patch, context);
  }
}

/**
 * Replace the database name in a postgres connection URL.
 * Handles both with and without query params: .../cryptoacc?schema=public
 */
function patchDatabaseUrl(url: string, dbName: string): string {
  return url.replace(
    /\/([^/?]+)(\?|$)/,
    `/${dbName}$2`,
  );
}

/**
 * Replace or append the DB index in a redis URL.
 * Handles: redis://...6379/0 → redis://...6379/3
 * Also handles missing index: redis://...6379 → redis://...6379/3
 */
function patchRedisUrl(url: string, redisDb: number): string {
  if (/\/\d+$/.test(url)) {
    return url.replace(/\/\d+$/, `/${redisDb}`);
  }
  return `${url}/${redisDb}`;
}

/** Replace port value entirely with the allocated port for the service */
function patchPort(patch: PatchConfig, context: PatchContext): string {
  const serviceName = patch.service;
  if (!serviceName || !(serviceName in context.ports)) {
    throw new Error(`Port patch requires a valid service name, got: ${serviceName}`);
  }
  return String(context.ports[serviceName]);
}

/**
 * Replace the port number inside a URL value.
 * e.g., http://localhost:3000/path → http://localhost:3100/path
 */
function patchUrlPort(
  value: string,
  patch: PatchConfig,
  context: PatchContext,
): string {
  const serviceName = patch.service;
  if (!serviceName || !(serviceName in context.ports)) {
    throw new Error(`URL patch requires a valid service name, got: ${serviceName}`);
  }
  const newPort = context.ports[serviceName];
  return value.replace(/:(\d+)/, `:${newPort}`);
}

/**
 * Patch all matching env vars in a file's content.
 * Processes line-by-line, replacing values for matching VAR= lines.
 */
export function patchEnvContent(
  content: string,
  patches: readonly PatchConfig[],
  context: PatchContext,
): string {
  const patchMap = new Map(patches.map((p) => [p.var, p]));
  const found = new Set<string>();

  const lines = content
    .split('\n')
    .map((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (!match) return line;

      const [, varName, rawValue] = match;
      const patch = patchMap.get(varName!);
      if (!patch) return line;

      found.add(varName!);
      const unquoted = rawValue!.replace(/^["']|["']$/g, '');
      const patched = applyPatch(unquoted, patch, context);
      const quote = rawValue!.startsWith('"') ? '"' : rawValue!.startsWith("'") ? "'" : '';
      return `${varName}=${quote}${patched}${quote}`;
    });

  // Append vars declared in patches but missing from the source file.
  // Only "port" patches can be computed without a source value.
  for (const patch of patches) {
    if (found.has(patch.var)) continue;
    if (patch.type === 'port') {
      const serviceName = patch.service;
      if (serviceName && serviceName in context.ports) {
        lines.push(`${patch.var}=${context.ports[serviceName]}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Copy and patch all env files from the main worktree to the target worktree.
 * Reads each source from mainRoot, patches it, writes to worktreeRoot.
 */
export function copyAndPatchAllEnvFiles(
  config: WtConfig,
  mainRoot: string,
  worktreeRoot: string,
  context: PatchContext,
): void {
  for (const envFile of config.envFiles) {
    const sourcePath = path.join(mainRoot, envFile.source);
    if (!fs.existsSync(sourcePath)) continue;

    const content = fs.readFileSync(sourcePath, 'utf-8');
    const patched = patchEnvContent(content, envFile.patches, context);

    const targetPath = path.join(worktreeRoot, envFile.source);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, patched, 'utf-8');
  }
}
