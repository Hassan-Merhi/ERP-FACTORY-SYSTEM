/**
 * Phase 7: independent, read-only proof that a LAN writer is protected by a
 * PostgreSQL transaction fence. A config ACK or nonempty users table is never
 * evidence that the remote cloud has been fenced.
 *
 * This check is deliberately fail-closed: an absent DBA-installed phase7_writer
 * schema, privileged app login, uncovered table or mismatched epoch blocks writes.
 */
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVerifiedPhase7WriterRow(row, { siteId, writerEpoch, baselineSha256 }) {
  return Boolean(
    row &&
    UUID.test(siteId ?? "") &&
    row.site_id === siteId &&
    row.mode === "lan-primary" &&
    row.epoch != null &&
    String(row.epoch) === String(writerEpoch) &&
    Number.isSafeInteger(Number(writerEpoch)) &&
    Number(writerEpoch) > 0 &&
    SHA256.test(baselineSha256 ?? "") &&
    row.baseline_sha256 === baselineSha256 &&
    row.role_safe === true &&
    Number(row.uncovered_tables) === 0
  );
}

const AUTHORITY_QUERY = [
  "WITH actor AS (",
  "  SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)",
  "    AND NOT has_schema_privilege(current_user, 'public', 'CREATE')",
  "    AND NOT has_database_privilege(current_user, current_database(), 'CREATE')",
  "    AND NOT pg_has_role(current_user, 'pg_write_all_data', 'MEMBER')",
  "    AND NOT EXISTS (",
  "      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
  "      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')",
  "        AND pg_has_role(current_user, c.relowner, 'MEMBER')",
  "    ) AS role_safe",
  "  FROM pg_roles r WHERE r.rolname = current_user",
  "), uncovered AS (",
  "  SELECT count(*)::integer AS total FROM pg_class c",
  "  JOIN pg_namespace n ON n.oid = c.relnamespace",
  "  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')",
  "    AND c.relname NOT IN ('session')",
  "    AND NOT EXISTS (",
  "      SELECT 1 FROM pg_trigger t",
  "      WHERE t.tgrelid = c.oid AND t.tgname = 'phase7_writer_fence'",
  "        AND t.tgenabled = 'O' AND NOT t.tgisinternal",
  "    )",
  ")",
  "SELECT s.site_id, s.mode, s.epoch, s.baseline_sha256,",
  "       a.role_safe, u.total AS uncovered_tables",
  "FROM phase7_writer.state s CROSS JOIN actor a CROSS JOIN uncovered u",
  "WHERE s.singleton IS TRUE"
].join("\n");

export async function hasVerifiedPhase7WriterAuthority(queryable, config) {
  if (config?.mode !== "lan" || !config.primary) return false;
  try {
    const { rows } = await queryable.query(AUTHORITY_QUERY);
    return rows?.length === 1 && isVerifiedPhase7WriterRow(rows[0], {
      siteId: config.siteId,
      writerEpoch: config.writerEpoch,
      baselineSha256: config.baselineSha256,
    });
  } catch {
    // Missing table, revoked privilege, disconnect, DDL change: no write access.
    return false;
  }
}
