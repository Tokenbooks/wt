const { execFileSync } = require('node:child_process');

const redisImage = 'redis:8-alpine';

try {
  execFileSync('docker', ['image', 'inspect', redisImage], { stdio: 'ignore' });
} catch {
  execFileSync('docker', ['pull', redisImage], { stdio: 'inherit' });
}

execFileSync(
  'pnpm',
  [
    'exec',
    'jest',
    '__tests__/docker-services.docker.spec.ts',
    '--runInBand',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      WT_RUN_DOCKER_TESTS: '1',
    },
  },
);
