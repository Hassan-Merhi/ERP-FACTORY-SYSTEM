/**
 * Phase 21 (A): audit trail checks of the integrity diagnostic.
 *
 *   audit_trail_triggers — AT5: the append-only triggers and the voucher /
 *     line audit and hash-chain triggers exist, are enabled (pg_trigger
 *     tgenabled 'O' or 'A'; a trigger disabled with ALTER TABLE … DISABLE
 *     TRIGGER or set to replica-only is listed) and the audit trigger function
 *     is at its installer's version. The application role owns the tables, so
 *     it could disable a trigger; this check is how that is seen (fail).
 *   audit_actor_unknown — AT2: database audit rows of this company written
 *     with no actor setting (user 'unknown'): a writer outside a request or a
 *     scheduled scope. Recorded, never refused (warn).
 *   audit_log_hash_chain — AT5: this company's audit rows whose hash does not
 *     match their content or whose link names no earlier row (fail); rows
 *     before the chain and fork leaves are counted in the sample (pass).
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { verifyAuditLogChain } from "../../audit/auditLogChain";
import { AUDIT_TRAIL_TRIGGERS, VOUCHER_AUDIT_TRIGGER_VERSION } from "../../audit/voucherAuditTrigger";
import { UNKNOWN_AUDIT_ACTOR } from "../../audit/auditActorContext";
import type { IntegrityCheck } from "./accountingIntegrityDiagnostic";

const SAMPLE_LIMIT = 20;
type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute<T>(query)).rows as unknown as T[];
}

export async function auditTrailChecks(companyId: number): Promise<IntegrityCheck[]> {
  const checks: IntegrityCheck[] = [];

  const installed = await rows<{ table_name: string; trigger: string; enabled: string }>(sql`
    SELECT c.relname AS table_name, t.tgname AS trigger, t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND t.tgname IN (${sql.join(
         AUDIT_TRAIL_TRIGGERS.map(([, trigger]) => sql`${trigger}`),
         sql`, `
       )})
  `);
  const problems: Row[] = [];
  for (const [table, trigger] of AUDIT_TRAIL_TRIGGERS) {
    const found = installed.find((row) => row.trigger === trigger && row.table_name === table);
    if (!found) problems.push({ table, trigger, problem: "missing" });
    else if (found.enabled !== "O" && found.enabled !== "A") {
      problems.push({ table, trigger, problem: found.enabled === "D" ? "disabled" : "replica_only" });
    }
  }
  const [version] = await rows<{ version: string | null }>(sql`
    SELECT obj_description(to_regprocedure('erp_ledger_row_audit()'), 'pg_proc') AS version
  `);
  if (version?.version !== VOUCHER_AUDIT_TRIGGER_VERSION) {
    problems.push({ trigger: "erp_ledger_row_audit", problem: `not at ${VOUCHER_AUDIT_TRIGGER_VERSION}` });
  }
  checks.push({
    key: "audit_trail_triggers",
    status: problems.length ? "fail" : "pass",
    count: problems.length,
    amount: null,
    explanation:
      "The audit_log append-only triggers, the voucher and line audit triggers and the audit_log hash-chain trigger must exist and be enabled, at the installer's version. The application role owns these tables and could disable a trigger; a missing or disabled one is listed here.",
    samples: problems.slice(0, SAMPLE_LIMIT),
  });

  const unknown = await rows<{ table_name: string; rows: number; first_at: string; last_at: string }>(sql`
    SELECT table_name, count(*)::int AS rows, min(created_at)::text AS first_at, max(created_at)::text AS last_at
      FROM audit_log
     WHERE company_id = ${companyId} AND user_id = ${UNKNOWN_AUDIT_ACTOR}
       AND action IN ('row_insert', 'row_update', 'row_delete')
     GROUP BY table_name
     ORDER BY table_name
  `);
  const unknownCount = unknown.reduce((sum, row) => sum + Number(row.rows), 0);
  checks.push({
    key: "audit_actor_unknown",
    status: unknownCount ? "warn" : "pass",
    count: unknownCount,
    amount: null,
    explanation:
      "Voucher and line changes the database audited with no actor (written outside a signed-in request or a scheduled job's scope). They are recorded as 'unknown', never refused; the writer should run in a request or a system scope.",
    samples: unknown,
  });

  const chain = await verifyAuditLogChain({ companyId, sampleLimit: SAMPLE_LIMIT });
  const chainFailures = chain.hashMismatch + chain.brokenLinks;
  checks.push({
    key: "audit_log_hash_chain",
    status: chainFailures ? "fail" : "pass",
    count: chainFailures,
    amount: null,
    explanation:
      "Each audit row's hash must match its content and name an earlier row's hash. A mismatch means a row was changed; a broken link means a linked row was removed. Rows before the chain was installed are unhashed and counted only.",
    samples: [
      {
        checked: chain.checked,
        unhashed: chain.unhashed,
        hashMismatch: chain.hashMismatch,
        brokenLinks: chain.brokenLinks,
        unlinked: chain.unlinked,
        headId: chain.headId,
        headHash: chain.headHash,
      },
      ...chain.failures,
    ],
  });
  return checks;
}
