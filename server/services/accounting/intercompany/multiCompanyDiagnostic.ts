/**
 * Multi-company diagnostic (accounting audit phase 26). Read-only; lists, never
 * repairs. For the current company:
 *
 *   - transfer_links_without_intercompany_accounts (warn): live links written
 *     before phase 26 (no from/to intercompany account id); group elimination
 *     derives the account from the leg, the owner may leave them;
 *   - transfer_links_out_of_step (fail): a live link whose amount differs from
 *     a leg's total, or whose leg is deleted;
 *   - intercompany_accounts_not_typed_intercompany (warn): IC-TO-/IC-FROM-
 *     accounts typed Asset/Liability (pre-phase 26); retype them by the
 *     account edit (sub-type Due From / Due To);
 *   - transfer_clearing_balance (warn): the legacy Equity-typed
 *     TRANSFER-CLEARING account still carries a balance (owner step:
 *     reclassify it to the intercompany accounts by journal);
 *   - parent_receivable_not_recorded (warn): a subsidiary whose parent
 *     receivable id (MC-9) is not recorded yet;
 *   - lines_on_other_company_accounts (fail): MC-10, see the Owner tool;
 *   - pos_mirror_without_cash_link (warn): an enabled POS mirror whose source
 *     cash accounts have no configured destination (nothing is mirrored);
 *   - global_ledger_code_unique (fail): MC-12, a unique index on
 *     ledger_accounts(code) alone.
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

/** A catalog (pg_index) lookup of the table's indexes, not a read of its rows. */
const CATALOG_LEDGER_TABLE = "ledger_accounts";

export interface MultiCompanyCheck {
  key: string;
  status: "pass" | "warn" | "fail";
  count: number;
  description: string;
  rows: Record<string, unknown>[];
}

function check(
  key: string,
  failStatus: "warn" | "fail",
  description: string,
  rows: Record<string, unknown>[]
): MultiCompanyCheck {
  return { key, status: rows.length ? failStatus : "pass", count: rows.length, description, rows: rows.slice(0, 200) };
}

export async function runMultiCompanyDiagnostic(companyId: number) {
  const q = async (query: ReturnType<typeof sql>) => resultRows(await db.execute(query));

  const legacyLinks = await q(sql`
    SELECT id, from_company_id, to_company_id, transfer_date::text, amount::text
      FROM inter_company_transfers
     WHERE deleted_at IS NULL AND (from_company_id = ${companyId} OR to_company_id = ${companyId})
       AND (CASE WHEN from_company_id = ${companyId} THEN from_ic_account_id ELSE to_ic_account_id END) IS NULL
     ORDER BY id
  `);
  const outOfStep = await q(sql`
    SELECT t.id, t.amount::text AS link_amount, fv.total_amount::text AS from_total, tv.total_amount::text AS to_total,
           (fv.deleted_at IS NOT NULL) AS from_deleted, (tv.deleted_at IS NOT NULL) AS to_deleted
      FROM inter_company_transfers t
      LEFT JOIN vouchers fv ON fv.id = t.from_voucher_id
      LEFT JOIN vouchers tv ON tv.id = t.to_voucher_id
     WHERE t.deleted_at IS NULL AND (t.from_company_id = ${companyId} OR t.to_company_id = ${companyId})
       AND t.source_type IS DISTINCT FROM 'cross-company-line-reclass'
       AND (fv.deleted_at IS NOT NULL OR tv.deleted_at IS NOT NULL
            OR round(fv.total_amount::numeric, 2) IS DISTINCT FROM round(t.amount::numeric, 2)
            OR round(tv.total_amount::numeric, 2) IS DISTINCT FROM round(t.amount::numeric, 2))
     ORDER BY t.id
  `);
  const untyped = await q(sql`
    SELECT id, code, name, account_type, sub_type
      FROM ledger_accounts
     WHERE company_id = ${companyId} AND deleted_at IS NULL
       AND (code LIKE 'IC-TO-%' OR code LIKE 'IC-FROM-%')
       AND lower(btrim(account_type)) IS DISTINCT FROM 'intercompany'
     ORDER BY code
  `);
  const clearing = await q(sql`
    SELECT la.id, la.code,
           (COALESCE(SUM(ve.debit_amount), 0) - COALESCE(SUM(ve.credit_amount), 0))::text AS balance
      FROM ledger_accounts la
      JOIN voucher_entries ve ON ve.ledger_account_id = la.id
      JOIN vouchers v ON v.id = ve.voucher_id AND v.company_id = la.company_id
     WHERE la.company_id = ${companyId} AND la.code = 'TRANSFER-CLEARING'
       AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
     GROUP BY la.id, la.code
    HAVING COALESCE(SUM(ve.debit_amount), 0) IS DISTINCT FROM COALESCE(SUM(ve.credit_amount), 0)
  `);
  const parentReceivable = await q(sql`
    SELECT c.id AS company_id, c.parent_company_id, pa.id AS candidate_account_id, pa.name AS candidate_account_name
      FROM companies c
      LEFT JOIN company_settings cs ON cs.company_id = c.id
      LEFT JOIN ledger_accounts pa ON pa.company_id = c.parent_company_id AND pa.name = c.name || ' Credit'
                                   AND pa.deleted_at IS NULL
     WHERE c.id = ${companyId} AND c.parent_company_id IS NOT NULL
       AND cs.parent_receivable_account_id IS NULL AND pa.id IS NOT NULL
  `);
  const crossCompany = await q(sql`
    SELECT v.id AS voucher_id, v.voucher_number, ve.id AS line_id, ve.ledger_account_id, la.company_id AS account_company_id,
           COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      JOIN ledger_accounts la ON la.id = ve.ledger_account_id
     WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
       AND la.company_id IS DISTINCT FROM v.company_id
     ORDER BY v.id, ve.id
  `);
  const posWithoutLink = await q(sql`
    SELECT cfg.id AS config_id, cfg.dest_company_id
      FROM intercompany_pos_configs cfg
     WHERE cfg.source_company_id = ${companyId} AND cfg.enabled = true
       AND NOT EXISTS (SELECT 1 FROM intercompany_account_links l
                        WHERE l.source_company_id = cfg.source_company_id
                          AND l.dest_company_id = cfg.dest_company_id AND l.active = true)
  `);
  const globalCodeUnique = await q(sql`
    SELECT i.relname AS index_name
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = ${CATALOG_LEDGER_TABLE} AND x.indisunique
       AND x.indnatts = 1
       AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = x.indkey[0]) = 'code'
  `);

  const checks: MultiCompanyCheck[] = [
    check(
      "transfer_links_without_intercompany_accounts",
      "warn",
      "Transfer links written before phase 26 do not record their intercompany accounts; group elimination derives them from the transfer vouchers.",
      legacyLinks
    ),
    check(
      "transfer_links_out_of_step",
      "fail",
      "Transfer links whose amount differs from a voucher's total, or whose voucher is deleted.",
      outOfStep
    ),
    check(
      "intercompany_accounts_not_typed_intercompany",
      "warn",
      "IC-TO-/IC-FROM- accounts typed as plain assets or liabilities. Change their type to Intercompany (sub-type Due From or Due To).",
      untyped
    ),
    check(
      "transfer_clearing_balance",
      "warn",
      "The legacy TRANSFER-CLEARING account still holds a balance. Reclassify it to the intercompany accounts with a journal.",
      clearing
    ),
    check(
      "parent_receivable_not_recorded",
      "warn",
      "The parent's receivable from this subsidiary is not recorded by id yet; the next PO import records it, or set it in the company settings.",
      parentReceivable
    ),
    check(
      "lines_on_other_company_accounts",
      "fail",
      "Posted lines of this company on another company's accounts. Use the cross-company line correction tool.",
      crossCompany
    ),
    check(
      "pos_mirror_without_cash_link",
      "warn",
      "The intercompany POS mirror is enabled but no destination cash account is configured, so no sale is mirrored.",
      posWithoutLink
    ),
    check(
      "global_ledger_code_unique",
      "fail",
      "A unique index on the ledger account code alone; codes are unique per company. Restart the server to drop it.",
      globalCodeUnique
    ),
  ];
  const status = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { companyId, generatedAt: new Date().toISOString(), status, checks };
}
