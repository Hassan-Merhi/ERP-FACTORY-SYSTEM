import type { PoolClient } from "pg";

import { pool } from "../../server/db";

/**
 * Runs test fixture writes in one transaction on one client.
 *
 * The voucher balance guard checks every active voucher at COMMIT, so a
 * fixture voucher and all of its lines must be written (or deleted) together:
 * a line inserted in its own autocommit statement commits a one-sided voucher.
 *
 * `legacyUnbalanced` sets `app.ledger_integrity_bypass` for this transaction
 * only. Use it solely for fixtures that deliberately model unbalanced legacy
 * rows predating the guard (drift-detection and diagnostic tests); a fixture
 * whose test does not depend on the imbalance should be balanced instead.
 */
export async function withFixtureTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  options: { legacyUnbalanced?: boolean } = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (options.legacyUnbalanced) {
      await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
