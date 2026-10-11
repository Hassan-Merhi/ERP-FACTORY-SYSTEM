/**
 * Phase 21 (A), AT5: verify the audit_log hash chain (voucherAuditTrigger.ts).
 *
 * For every hashed row (optionally one company's) it recomputes the row hash
 * from the stored content and checks the link to its predecessor:
 *   - hashMismatch: the stored row_hash is not the hash of the row as it is now
 *     (the row was edited, e.g. under a trigger bypass);
 *   - brokenLinks: prev_hash names no earlier row (the predecessor was deleted
 *     or rewritten);
 *   - unlinked: chained rows no later row links to, other than the newest (the
 *     head). Concurrent inserts can fork the chain (no lock is taken), so a few
 *     are expected; deleting such a row is not detectable by its links;
 *   - unhashed: rows written before the chain was installed (no hash).
 * Read-only. A full verification scans audit_log; run it from the integrity
 * diagnostic or by hand, not on every request.
 */
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../db";
import { AUDIT_CHAIN_GENESIS } from "./voucherAuditTrigger";

export interface AuditLogChainReport {
  checked: number;
  unhashed: number;
  hashMismatch: number;
  brokenLinks: number;
  unlinked: number;
  headId: number | null;
  headHash: string | null;
  /** Up to `sampleLimit` failing rows. */
  failures: Array<{ id: number; tableName: string; reason: "hash_mismatch" | "broken_link" }>;
}

type Row = Record<string, unknown>;

export async function verifyAuditLogChain(
  options: { companyId?: number | null; sampleLimit?: number } = {},
  executor: DatabaseOrTransaction = db
): Promise<AuditLogChainReport> {
  const companyId = options.companyId ?? null;
  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? 20, 200));
  const scope = companyId === null ? sql`true` : sql`a.company_id = ${companyId}`;

  // Anti-joins in WHERE clauses (hash anti joins), never correlated subplans per row.
  const summary = await executor.execute<Row>(sql`
    WITH scoped AS MATERIALIZED (
      SELECT a.id, a.table_name, a.prev_hash, a.row_hash,
             (a.row_hash IS NOT NULL AND a.row_hash IS DISTINCT FROM erp_audit_log_row_hash(a)) AS mismatch
        FROM audit_log a
       WHERE ${scope}
    ), head AS (
      SELECT id, row_hash FROM audit_log WHERE prev_hash IS NOT NULL ORDER BY id DESC LIMIT 1
    ), broken AS (
      SELECT s.id FROM scoped s
       WHERE s.prev_hash IS NOT NULL AND s.prev_hash <> ${AUDIT_CHAIN_GENESIS}
         AND NOT EXISTS (SELECT 1 FROM audit_log p WHERE p.row_hash = s.prev_hash AND p.id < s.id)
    ), unlinked AS (
      SELECT s.id FROM scoped s
       WHERE s.prev_hash IS NOT NULL AND s.id <> COALESCE((SELECT id FROM head), 0)
         AND NOT EXISTS (SELECT 1 FROM audit_log n WHERE n.prev_hash = s.row_hash AND n.id > s.id)
    ), failures AS (
      SELECT s.id, s.table_name, CASE WHEN s.mismatch THEN 'hash_mismatch' ELSE 'broken_link' END AS reason
        FROM scoped s
       WHERE s.mismatch OR s.id IN (SELECT id FROM broken)
       ORDER BY s.id
       LIMIT ${sampleLimit}
    )
    SELECT (SELECT count(*) FROM scoped WHERE row_hash IS NOT NULL)::int AS checked,
           (SELECT count(*) FROM scoped WHERE row_hash IS NULL)::int AS unhashed,
           (SELECT count(*) FROM scoped WHERE mismatch)::int AS hash_mismatch,
           (SELECT count(*) FROM broken)::int AS broken_links,
           (SELECT count(*) FROM unlinked)::int AS unlinked,
           (SELECT id FROM head) AS head_id,
           (SELECT row_hash FROM head) AS head_hash,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'tableName', f.table_name, 'reason', f.reason)
                                      ORDER BY f.id) FROM failures f), '[]'::jsonb) AS failures
  `);
  const row = summary.rows[0] ?? {};
  return {
    checked: Number(row.checked ?? 0),
    unhashed: Number(row.unhashed ?? 0),
    hashMismatch: Number(row.hash_mismatch ?? 0),
    brokenLinks: Number(row.broken_links ?? 0),
    unlinked: Number(row.unlinked ?? 0),
    headId: row.head_id === null || row.head_id === undefined ? null : Number(row.head_id),
    headHash: (row.head_hash as string | null) ?? null,
    failures: (row.failures as AuditLogChainReport["failures"]) ?? [],
  };
}
