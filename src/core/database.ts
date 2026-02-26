import { Client } from 'pg';

type SqlLogger = (statement: string) => void;

/**
 * Parse a postgres connection URL to extract the host, port, user, password.
 * Used to connect to the 'postgres' maintenance DB for admin operations.
 */
function buildAdminConnectionConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'postgres',
  };
}

/** Connect to the postgres maintenance database for admin operations */
async function withAdminClient<T>(
  databaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(buildAdminConnectionConfig(databaseUrl));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function formatQueryLog(query: string, params: readonly unknown[] = []): string {
  if (params.length === 0) {
    return query;
  }
  const bindings = params
    .map((value, index) => `$${index + 1}=${JSON.stringify(value)}`)
    .join(', ');
  return `${query} -- ${bindings}`;
}

/**
 * Create a new database by cloning the template database.
 * Uses CREATE DATABASE ... TEMPLATE for fast, consistent copies.
 */
export async function createDatabase(
  databaseUrl: string,
  templateName: string,
  targetName: string,
  logSql?: SqlLogger,
): Promise<void> {
  await withAdminClient(databaseUrl, async (client) => {
    // Terminate connections to the template DB so TEMPLATE works
    const terminateSql =
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()';
    logSql?.(formatQueryLog(terminateSql, [templateName]));
    await client.query(terminateSql, [templateName]);

    const createSql = `CREATE DATABASE ${quoteIdentifier(targetName)} TEMPLATE ${quoteIdentifier(templateName)}`;
    logSql?.(formatQueryLog(createSql));
    await client.query(createSql);
  });
}

/** Drop a database if it exists. Refuses to drop the template database. */
export async function dropDatabase(
  databaseUrl: string,
  dbName: string,
  templateName: string,
  logSql?: SqlLogger,
): Promise<void> {
  if (dbName === templateName) {
    throw new Error(`Refusing to drop template database: ${templateName}`);
  }
  await withAdminClient(databaseUrl, async (client) => {
    // Terminate active connections first
    const terminateSql =
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()';
    logSql?.(formatQueryLog(terminateSql, [dbName]));
    await client.query(terminateSql, [dbName]);

    const dropSql = `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`;
    logSql?.(formatQueryLog(dropSql));
    await client.query(dropSql);
  });
}

/** Check if a database exists */
export async function databaseExists(
  databaseUrl: string,
  dbName: string,
): Promise<boolean> {
  return withAdminClient(databaseUrl, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    );
    return result.rowCount !== null && result.rowCount > 0;
  });
}

/** List all databases matching a pattern (for doctor command) */
export async function listDatabasesByPattern(
  databaseUrl: string,
  pattern: string,
): Promise<string[]> {
  return withAdminClient(databaseUrl, async (client) => {
    const result = await client.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
      [pattern],
    );
    return result.rows.map((row: { datname: string }) => row.datname);
  });
}
