/**
 * Compliance / screen-watch hot-path indexes on user_presence.
 *
 * Mirrors migrations/20260917_001_user_presence_compliance_indexes.sql so boot
 * on a fresh or long-lived database converges without a separate runner.
 */
export const userPresenceComplianceIndexes: string[] = [
  `CREATE INDEX IF NOT EXISTS user_presence_last_seen_idx ON user_presence (last_seen)`,
  `CREATE INDEX IF NOT EXISTS user_presence_company_last_seen_idx ON user_presence (company_id, last_seen)`,
  `CREATE INDEX IF NOT EXISTS user_presence_user_last_seen_idx ON user_presence (user_id, last_seen)`,
];
