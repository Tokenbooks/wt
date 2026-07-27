import * as fs from 'node:fs';
import * as path from 'node:path';
import { rewriteEnvPaths, type EnvPathEscape, type EnvPathRoots } from './env-paths';
import type { EnvFileConfig, PatchConfig, PatchContext, WtConfig } from '../types';

type PortPatch = Extract<PatchConfig, { type: 'port' }>;
type UrlPatch = Extract<PatchConfig, { type: 'url' }>;
type BranchPatch = Extract<PatchConfig, { type: 'branch' }>;

export interface SeedEnvFileResult {
  readonly source: string;
  readonly target: string;
  readonly created: boolean;
  readonly addedVars: string[];
}

export interface SeedEnvFilesResult {
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly files: SeedEnvFileResult[];
}

export interface CopyAndPatchEnvFilesResult {
  readonly escapes: readonly EnvPathEscape[];
}

interface EnvAssignment {
  readonly varName: string;
  readonly line: string;
}

const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

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
    case 'port':
      return patchPort(patch, context);
    case 'url':
      return patchUrlPort(value, patch, context);
    case 'branch':
      return patchBranch(patch, context);
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

/** Replace port value entirely with the allocated port for the service */
function patchPort(patch: PortPatch, context: PatchContext): string {
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
  patch: UrlPatch,
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
 * Replace an env var value with the current git branch name.
 * Useful for setting APP_ENV to distinguish worktree deployments in telemetry.
 */
function patchBranch(_patch: BranchPatch, context: PatchContext): string {
  if (context.branchName === undefined) {
    throw new Error('Branch patch requires branchName in context.');
  }
  return context.branchName;
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
  // "port" and "branch" patches can be computed without a source value.
  for (const patch of patches) {
    if (found.has(patch.var)) continue;
    if (patch.type === 'port') {
      const serviceName = patch.service;
      if (serviceName && serviceName in context.ports) {
        lines.push(`${patch.var}=${context.ports[serviceName]}`);
      }
    } else if (patch.type === 'branch' && context.branchName !== undefined) {
      lines.push(`${patch.var}=${context.branchName}`);
    }
  }

  return lines.join('\n');
}

function collectEnvAssignments(content: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(ENV_ASSIGNMENT_PATTERN);
    if (!match?.[1]) continue;
    assignments.push({ varName: match[1], line });
  }
  return assignments;
}

function collectEnvVarNames(content: string): Set<string> {
  return new Set(collectEnvAssignments(content).map((assignment) => assignment.varName));
}

function appendMissingEnvLines(
  targetContent: string,
  source: string,
  missingAssignments: readonly EnvAssignment[],
): string {
  const normalized =
    targetContent.length === 0 || targetContent.endsWith('\n')
      ? targetContent
      : `${targetContent}\n`;
  const separated =
    normalized.length === 0 || normalized.endsWith('\n\n')
      ? normalized
      : `${normalized}\n`;
  const missingLines = missingAssignments.map((assignment) => assignment.line);
  return `${separated}# Added from ${source} by wt\n${missingLines.join('\n')}\n`;
}

/**
 * Create configured env files from examples and merge missing safe defaults.
 * Existing developer values are never overwritten.
 */
export function seedEnvFileDefaults(
  envFiles: readonly EnvFileConfig[],
  root: string,
  options: { readonly dryRun: boolean },
): SeedEnvFilesResult {
  const files: SeedEnvFileResult[] = [];

  for (const envFile of envFiles) {
    if (!envFile.seedFrom) continue;

    const sourcePath = path.join(root, envFile.seedFrom);
    const targetPath = path.join(root, envFile.source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Seed env source not found: ${envFile.seedFrom}`);
    }

    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceAssignments = collectEnvAssignments(sourceContent);

    if (!fs.existsSync(targetPath)) {
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, sourceContent, 'utf-8');
      }
      files.push({
        source: envFile.seedFrom,
        target: envFile.source,
        created: true,
        addedVars: sourceAssignments.map((assignment) => assignment.varName),
      });
      continue;
    }

    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const targetVars = collectEnvVarNames(targetContent);
    const seenMissingVars = new Set<string>();
    const missingAssignments = sourceAssignments.filter((assignment) => {
      if (targetVars.has(assignment.varName) || seenMissingVars.has(assignment.varName)) {
        return false;
      }
      seenMissingVars.add(assignment.varName);
      return true;
    });

    if (missingAssignments.length > 0 && !options.dryRun) {
      fs.writeFileSync(
        targetPath,
        appendMissingEnvLines(targetContent, envFile.seedFrom, missingAssignments),
        'utf-8',
      );
    }

    files.push({
      source: envFile.seedFrom,
      target: envFile.source,
      created: false,
      addedVars: missingAssignments.map((assignment) => assignment.varName),
    });
  }

  return {
    dryRun: options.dryRun,
    changed: files.some((file) => file.created || file.addedVars.length > 0),
    files,
  };
}

/**
 * Copy and patch all env files from the main worktree to the target worktree.
 * Absolute paths pointing back at the source checkout are repointed and reported.
 * See docs/env-path-isolation.md.
 */
export function copyAndPatchAllEnvFiles(
  config: WtConfig,
  mainRoot: string,
  worktreeRoot: string,
  context: PatchContext,
): CopyAndPatchEnvFilesResult {
  for (const envFile of config.envFiles) {
    const sourcePath = path.join(mainRoot, envFile.source);
    if (!fs.existsSync(sourcePath)) continue;

    const content = fs.readFileSync(sourcePath, 'utf-8');
    const targetPath = path.join(worktreeRoot, envFile.source);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
  }

  seedEnvFileDefaults(config.envFiles, worktreeRoot, { dryRun: false });

  const roots: EnvPathRoots = {
    worktreeRoot,
    mainRoot,
    worktreesDir: path.resolve(mainRoot, config.baseWorktreePath),
  };
  const escapes: EnvPathEscape[] = [];

  for (const envFile of config.envFiles) {
    const targetPath = path.join(worktreeRoot, envFile.source);
    if (!fs.existsSync(targetPath)) continue;

    const content = fs.readFileSync(targetPath, 'utf-8');
    const patched = patchEnvContent(content, envFile.patches ?? [], context);
    const repointed = rewriteEnvPaths(patched, envFile.source, roots);
    fs.writeFileSync(targetPath, repointed.content, 'utf-8');
    escapes.push(...repointed.escapes);
  }

  return { escapes };
}
