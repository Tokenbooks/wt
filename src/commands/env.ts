import * as path from 'node:path';
import { getMainWorktreePath } from '../core/git';
import { seedEnvFileDefaults, type SeedEnvFilesResult } from '../core/env-patcher';
import { extractErrorMessage, formatJson, success, error } from '../output';
import { loadConfig } from './setup';

interface EnvSeedOptions {
  readonly json: boolean;
  readonly dryRun: boolean;
}

export function envSeedCommand(
  targetPath: string | undefined,
  options: EnvSeedOptions,
): void {
  try {
    const mainRoot = getMainWorktreePath();
    const config = loadConfig(mainRoot);
    const root = path.resolve(targetPath ?? process.cwd());
    const result = seedEnvFileDefaults(config.envFiles, root, {
      dryRun: options.dryRun,
    });

    if (options.json) {
      console.log(formatJson(success(result)));
    } else {
      console.log(formatEnvSeedSummary(result));
    }
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('ENV_SEED_FAILED', message)));
    } else {
      console.error(`Env seed failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

function formatEnvSeedSummary(result: SeedEnvFilesResult): string {
  if (result.files.length === 0) {
    return result.dryRun
      ? '[dry-run] No seed env files configured.'
      : 'No seed env files configured.';
  }

  const lines = [result.dryRun ? '[dry-run] Env seed preview:' : 'Env seed result:'];
  for (const file of result.files) {
    if (file.created) {
      lines.push(
        `  ${file.target}: ${result.dryRun ? 'would create' : 'created'} from ${file.source} (${file.addedVars.length} vars)`,
      );
    } else if (file.addedVars.length > 0) {
      lines.push(
        `  ${file.target}: ${result.dryRun ? 'would add' : 'added'} ${file.addedVars.join(', ')} from ${file.source}`,
      );
    } else {
      lines.push(`  ${file.target}: no missing vars`);
    }
  }

  if (result.dryRun && result.changed) {
    lines.push('[dry-run] No changes written.');
  }

  return lines.join('\n');
}
