import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { SCHEMA_SQL } from './schema'; // <-- import embedded SQL

const logger = createLogger('db');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error('Unexpected idle client error', { error: err.message });
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    logger.debug('Query executed', { durationMs: Date.now() - start, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Query failed', {
      error: err instanceof Error ? err.message : String(err),
      text,
    });
    throw err;
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function initSchema(): Promise<void> {
  // Use embedded SQL constant instead of reading from file system
  await pool.query(SCHEMA_SQL);
  logger.info('Schema initialized');
}

export async function closePool(): Promise<void> {
  await pool.end();
}