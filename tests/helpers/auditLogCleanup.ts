import type { Pool } from "pg";

/**
 * Removes a test's own audit_log rows.
 *
 * audit_log is append-only (wave 12, server/services/audit/auditLogAppendOnlyGuard.ts):
 * its trigger refuses DELETE outside the retention job. Test teardown runs as
 * the database superuser, which may switch triggers off for one transaction
 * with `SET LOCAL session_replication_role = replica` — the same power that
 * could drop the trigger, so this is not a bypass the application role has.
 *
 * `where` is a fixed SQL condition on audit_log with $1.. placeholders and
 * `params` its values. When the role cannot switch replication role (not a
 * superuser), the rows are left in place: audit_log has no foreign keys, so
 * leftover rows never block the company deletes that follow.
 */
export async function deleteAuditLogRowsForTests(pool: Pool, where: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`DELETE FROM audit_log WHERE ${where}`, params);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = (error as { code?: string }).code;
    // 42501: not allowed to set session_replication_role. Leave the rows.
    if (code !== "42501") throw error;
  } finally {
    client.release();
  }
}
