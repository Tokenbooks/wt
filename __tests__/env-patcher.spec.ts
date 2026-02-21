import { describe, it, expect } from '@jest/globals';
import { patchEnvContent } from '../src/core/env-patcher';
import type { PatchConfig, PatchContext } from '../src/types';

describe('env-patcher', () => {
  const context: PatchContext = {
    dbName: 'cryptoacc_wt3',
    redisDb: 3,
    ports: { app: 3300, server: 3301, 'sync-exchanges': 3302 },
  };

  describe('database patch', () => {
    const patches: PatchConfig[] = [
      { var: 'DATABASE_URL', type: 'database' },
    ];

    it.each([
      [
        'quoted URL with query params',
        'DATABASE_URL="postgresql://user:password@localhost:5432/cryptoacc?schema=public"',
        'DATABASE_URL="postgresql://user:password@localhost:5432/cryptoacc_wt3?schema=public"',
      ],
      [
        'unquoted URL with query params',
        'DATABASE_URL=postgresql://user:password@localhost:5432/cryptoacc?schema=public',
        'DATABASE_URL=postgresql://user:password@localhost:5432/cryptoacc_wt3?schema=public',
      ],
      [
        'URL without query params',
        'DATABASE_URL=postgresql://user:password@localhost:5432/cryptoacc',
        'DATABASE_URL=postgresql://user:password@localhost:5432/cryptoacc_wt3',
      ],
    ])('%s', (_name, input, expected) => {
      // Act
      const result = patchEnvContent(input, patches, context);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('redis patch', () => {
    const patches: PatchConfig[] = [{ var: 'REDIS_URL', type: 'redis' }];

    it.each([
      [
        'with existing DB index',
        'REDIS_URL=redis://:local_password@127.0.0.1:6379/0',
        'REDIS_URL=redis://:local_password@127.0.0.1:6379/3',
      ],
      [
        'without DB index',
        'REDIS_URL=redis://:local_password@localhost:6379',
        'REDIS_URL=redis://:local_password@localhost:6379/3',
      ],
    ])('%s', (_name, input, expected) => {
      // Act
      const result = patchEnvContent(input, patches, context);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('port patch', () => {
    const patches: PatchConfig[] = [
      { var: 'PORT', type: 'port', service: 'server' },
    ];

    it('replaces port value entirely', () => {
      // Act
      const result = patchEnvContent('PORT=3001', patches, context);

      // Assert
      expect(result).toBe('PORT=3301');
    });
  });

  describe('url patch', () => {
    const patches: PatchConfig[] = [
      { var: 'NEST_SERVER_URL', type: 'url', service: 'server' },
    ];

    it('replaces port in a URL value', () => {
      // Act
      const result = patchEnvContent(
        'NEST_SERVER_URL=http://localhost:3001',
        patches,
        context,
      );

      // Assert
      expect(result).toBe('NEST_SERVER_URL=http://localhost:3301');
    });
  });

  describe('missing port var', () => {
    const patches: PatchConfig[] = [
      { var: 'PORT', type: 'port', service: 'server' },
    ];

    it('appends port var when missing from source', () => {
      const content = 'DATABASE_URL=postgresql://localhost/mydb\nSOME_VAR=hello';

      const result = patchEnvContent(content, patches, context);

      expect(result).toBe(
        'DATABASE_URL=postgresql://localhost/mydb\nSOME_VAR=hello\nPORT=3301',
      );
    });

    it('does not duplicate when port var already exists', () => {
      const result = patchEnvContent('PORT=3001', patches, context);

      expect(result).toBe('PORT=3301');
    });
  });

  describe('multi-line env content', () => {
    it('patches only matching vars and preserves other lines', () => {
      // Arrange
      const content = [
        'DATABASE_URL="postgresql://user:pw@localhost:5432/cryptoacc?schema=public"',
        'REDIS_URL=redis://:local_password@127.0.0.1:6379/0',
        'PORT=3001',
        '# A comment',
        'SOME_OTHER_VAR=hello',
      ].join('\n');

      const patches: PatchConfig[] = [
        { var: 'DATABASE_URL', type: 'database' },
        { var: 'REDIS_URL', type: 'redis' },
        { var: 'PORT', type: 'port', service: 'server' },
      ];

      // Act
      const result = patchEnvContent(content, patches, context);

      // Assert
      const lines = result.split('\n');
      expect(lines[0]).toContain('cryptoacc_wt3');
      expect(lines[1]).toContain('/3');
      expect(lines[2]).toBe('PORT=3301');
      expect(lines[3]).toBe('# A comment');
      expect(lines[4]).toBe('SOME_OTHER_VAR=hello');
    });
  });
});
