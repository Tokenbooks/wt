import { afterEach, describe, expect, it, jest } from '@jest/globals';

type QueryResult = { rows: Array<Record<string, unknown>> };

const mockConnect = jest.fn<() => Promise<void>>();
const mockEnd = jest.fn<() => Promise<void>>();
const mockQuery = jest.fn<(sql: string, params?: readonly unknown[]) => Promise<QueryResult>>();

jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

import { dropDatabase } from './database';

const DATABASE_URL = 'postgresql://user:pw@localhost:5432/myapp';

describe('dropDatabase replication slot cleanup', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('drops logical replication slots bound to the database before DROP DATABASE', async () => {
    // Arrange: the target database still has an Electric replication slot.
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    mockQuery.mockImplementation((sql) => {
      if (sql.includes('pg_replication_slots')) {
        return Promise.resolve({ rows: [{ slot_name: 'electric_slot_myapp_wt1' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Act
    await dropDatabase(DATABASE_URL, 'myapp_wt1', 'myapp');

    // Assert: the slot is dropped, and strictly before the database itself.
    const statements = mockQuery.mock.calls.map((call) => call[0]);
    const dropSlotIndex = statements.findIndex((sql) => sql.includes('pg_drop_replication_slot'));
    const dropDbIndex = statements.findIndex((sql) => sql.includes('DROP DATABASE'));
    expect(dropSlotIndex).toBeGreaterThanOrEqual(0);
    expect(dropDbIndex).toBeGreaterThanOrEqual(0);
    expect(dropSlotIndex).toBeLessThan(dropDbIndex);

    const dropSlotCall = mockQuery.mock.calls.find((call) =>
      call[0].includes('pg_drop_replication_slot'),
    );
    expect(dropSlotCall?.[1]).toEqual(['electric_slot_myapp_wt1']);
  });

  it('drops the database when no replication slots remain', async () => {
    // Arrange: no slots reference the target database.
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });

    // Act
    await dropDatabase(DATABASE_URL, 'myapp_wt1', 'myapp');

    // Assert
    const statements = mockQuery.mock.calls.map((call) => call[0]);
    expect(statements.some((sql) => sql.includes('DROP DATABASE'))).toBe(true);
    expect(statements.some((sql) => sql.includes('pg_drop_replication_slot'))).toBe(false);
  });
});
