// Extracted from ./accountingIntegrityDiagnostic.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { classifyAccountType } from "../accountClassification";
import { LEDGER_GUARD_CONSTRAINTS, LEDGER_INTEGRITY_GUARD_VERSION } from "../ledgerIntegrityGuard";
import { CLOSED_PERIOD_GUARD_VERSION } from "../closedPeriodGuard";
import { VOUCHER_BALANCE_GUARD_VERSION, VOUCHER_HISTORY_MARKER_COLUMN } from "../voucherBalanceGuard";
import { OPENING_BALANCE_LOCK_VERSION } from "../openingBalanceLock";
import { CURRENCY_NORMALIZATION_FUNCTION, CURRENCY_NORMALIZATION_GUARD_VERSION } from "../currencyNormalizationGuard";
import {
  LEDGER_INTEGRITY_WAVE12_TRIGGERS,
  LIVE,
  check,
  rows,
  runAccountingIntegrityDiagnosticStep1,
} from "./runAccountingIntegrityDiagnosticStep1";
import { runAccountingIntegrityDiagnosticStep2 } from "./runAccountingIntegrityDiagnosticStep2";

export async function runAccountingIntegrityDiagnosticStep3(
  {
    accounts,
    checks,
  }: Pick<
    Awaited<ReturnType<typeof runAccountingIntegrityDiagnosticStep1>> &
      Awaited<ReturnType<typeof runAccountingIntegrityDiagnosticStep2>>,
    "accounts" | "checks"
  >,
  companyId: number
) {
  // Wave 18 (B): the INVENTORY control account is found by code only and never
  // changed; a row that blocks it (INVENTORY deleted or not an asset, or no
  // INVENTORY and another account holding the name) makes stock postings refuse.
  const inventoryCandidates = await rows<{
    id: number;
    code: string;
    name: string;
    account_type: string;
    sub_type: string | null;
    deleted: boolean;
  }>(sql`
    SELECT id, code, name, account_type, sub_type, (deleted_at IS NOT NULL) AS deleted
      FROM ledger_accounts
     WHERE company_id = ${companyId}
       AND (code = 'INVENTORY' OR (deleted_at IS NULL AND name = 'Inventory'))
     ORDER BY id
  `);
  const inventoryByCode = inventoryCandidates.find((account) => account.code === "INVENTORY");
  const inventoryConflicts = inventoryByCode
    ? inventoryByCode.deleted
      ? [{ ...inventoryByCode, reason: "deleted" }]
      : classifyAccountType(inventoryByCode.account_type, inventoryByCode.sub_type) !== "asset"
        ? [{ ...inventoryByCode, reason: "not_asset" }]
        : []
    : inventoryCandidates.map((account) => ({ ...account, reason: "name_taken" }));
  checks.push(
    check(
      "inventory_control_account_conflict",
      inventoryConflicts.length ? "warn" : "pass",
      inventoryConflicts.length,
      "The INVENTORY control account is resolved by code only and never retyped, renamed or restored. Listed: an INVENTORY account that is deleted or not an asset, or (with no INVENTORY account) another account holding the name Inventory. Stock and credit-note postings that need the control account refuse until it is corrected.",
      inventoryConflicts
    )
  );
  const hasEquity = accounts.some((account) => account.account_type === "Equity");
  checks.push(
    check(
      "no_equity_account",
      hasEquity ? "pass" : "fail",
      hasEquity ? 0 : 1,
      "The company has no Equity account, so capital and retained earnings cannot be shown."
    )
  );

  // 9. Database guards installed (ensureLedgerIntegrityGuard / ensureClosedPeriodGuard).
  const guards = await rows<{ name: string }>(sql`
    SELECT tgname AS name FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN ('voucher_entries_target_guard', 'ledger_accounts_delete_guard',
                      'voucher_entries_closed_period_guard', 'vouchers_closed_period_guard',
                      'audit_log_append_only', 'audit_log_no_truncate')
    UNION ALL
    -- Wave 12 (A): balance guard v3 and the opening-balance lock.
    SELECT tgname AS name FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN (${sql.join(
         LEDGER_INTEGRITY_WAVE12_TRIGGERS.map((name) => sql`${name}`),
         sql`, `
       )})
    UNION ALL
    SELECT conname AS name FROM pg_constraint
     WHERE conrelid = 'voucher_entries'::regclass
       AND conname IN (${sql.join(
         LEDGER_GUARD_CONSTRAINTS.map((name) => sql`${name}`),
         sql`, `
       )})
  `);
  const missingGuards = [
    "voucher_entries_target_guard",
    "ledger_accounts_delete_guard",
    "voucher_entries_closed_period_guard",
    "vouchers_closed_period_guard",
    // Wave 12 (B): audit_log append-only (auditLogAppendOnlyGuard.ts).
    "audit_log_append_only",
    "audit_log_no_truncate",
    ...LEDGER_GUARD_CONSTRAINTS,
    // Wave 12 (A): balance guard v3 and the opening-balance lock.
    ...LEDGER_INTEGRITY_WAVE12_TRIGGERS,
  ].filter((name) => !guards.some((guard) => guard.name === name));
  // Wave 12 (A): the balance guard must be at its current version, with its history marker
  // (a catalogue read, not tenant data).
  const HISTORY_MARKER_TABLE = "vouchers";
  const [guardState] = await rows<{ version: string | null; marker: boolean }>(sql`
    SELECT obj_description(to_regprocedure('erp_voucher_balance_check(integer)'), 'pg_proc') AS version,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = ${HISTORY_MARKER_TABLE}
                      AND column_name = ${VOUCHER_HISTORY_MARKER_COLUMN}) AS marker
  `);
  if (guardState?.version !== VOUCHER_BALANCE_GUARD_VERSION) {
    missingGuards.push(`erp_voucher_balance_check ${VOUCHER_BALANCE_GUARD_VERSION}`);
  }
  if (!guardState?.marker) missingGuards.push(`vouchers.${VOUCHER_HISTORY_MARKER_COLUMN}`);
  // Wave 14 (A): the currency normalization trigger at its installer's version.
  const [currencyGuard] = await rows<{ version: string | null }>(sql`
    SELECT obj_description(to_regprocedure(${`${CURRENCY_NORMALIZATION_FUNCTION}()`}), 'pg_proc') AS version
  `);
  if (currencyGuard?.version !== CURRENCY_NORMALIZATION_GUARD_VERSION) {
    missingGuards.push(`${CURRENCY_NORMALIZATION_FUNCTION} ${CURRENCY_NORMALIZATION_GUARD_VERSION}`);
  }
  // Wave 16 (B): the line-target guard (exactly one target) and the opening
  // lock (factory suppliers and fixed assets) at their current versions.
  const [ledgerGuardVersions] = await rows<{ target: string | null; opening: string | null }>(sql`
    SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS target,
           obj_description(to_regprocedure('erp_opening_balance_lock_guard()'), 'pg_proc') AS opening
  `);
  if (ledgerGuardVersions?.target !== LEDGER_INTEGRITY_GUARD_VERSION) {
    missingGuards.push(`erp_voucher_entry_target_guard ${LEDGER_INTEGRITY_GUARD_VERSION}`);
  }
  if (ledgerGuardVersions?.opening !== OPENING_BALANCE_LOCK_VERSION) {
    missingGuards.push(`erp_opening_balance_lock_guard ${OPENING_BALANCE_LOCK_VERSION}`);
  }
  // Phase 19 (B): the closed-period guard without the maintenance bypass.
  const [closedGuard] = await rows<{ version: string | null }>(sql`
    SELECT obj_description(to_regprocedure('erp_closed_period_guard_bypassed()'), 'pg_proc') AS version
  `);
  if (closedGuard?.version !== CLOSED_PERIOD_GUARD_VERSION) {
    missingGuards.push(`erp_closed_period_guard_bypassed ${CLOSED_PERIOD_GUARD_VERSION}`);
  }
  checks.push(
    check(
      "database_guards_installed",
      missingGuards.length ? "fail" : "pass",
      missingGuards.length,
      "Ledger integrity (current version: one target per new line), closed-period, balance (current version, with its history marker), opening-balance lock (current version) and currency normalization (current version) guards that must exist on the ledger tables.",
      missingGuards.map((name) => ({ missing: name }))
    )
  );

  // 10. Legacy stored plug left by the old import-cycle auto-adjustment.
  const plug = await rows<{ value: string; updated_at: string }>(sql`
    SELECT value, updated_at::text FROM system_settings WHERE key = ${`equity_adjustment_${companyId}`}
  `);
  const plugValue = plug[0] ? toMoney(plug[0].value) : new MoneyDecimal(0);
  checks.push(
    check(
      "legacy_equity_plug",
      plugValue.isZero() ? "pass" : "warn",
      plugValue.isZero() ? 0 : 1,
      "A balancing figure the dashboard used to store to show the import cycle as 0. It is no longer written or used; it is the size of the difference that was being hidden.",
      plug,
      plugValue.toFixed(2)
    )
  );

  // 11. Revaluation journals that saving an exchange rate used to post (wave 9
  // stopped it). They revalued every Cash account as if it held CFA, so each is
  // a candidate for a reviewed reversal; none is changed here.
  const revaluations = await rows<{ id: number; voucher_number: string; voucher_date: string; amount: string }>(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.total_amount::text AS amount
      FROM vouchers v
     WHERE v.company_id = ${companyId} AND v.voucher_number LIKE 'FX-REVAL-%'
       AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
     ORDER BY v.voucher_date, v.id
  `);
  checks.push(
    check(
      "automatic_fx_revaluation_journals",
      revaluations.length ? "warn" : "pass",
      revaluations.length,
      "Journals posted automatically when an exchange rate was saved. They revalued every Cash account as if it held CFA, whatever its currency, so their amounts need review; no new ones are posted.",
      revaluations,
      revaluations.reduce((sum, row) => sum.plus(toMoney(row.amount)), new MoneyDecimal(0)).toFixed(2)
    )
  );

  // 12. Container commission with no FACTORY-COMM-{container} journal (wave 8.4
  // continuation). Commission is journalled when it is set or changed; legacy
  // containers are listed here and in the factory-supplier memo, not back-filled.
  const unjournalledCommission = await rows<{
    id: number;
    container_number: string;
    commission_amount: string;
    currency: string;
  }>(sql`
    SELECT fc.id, fc.container_number, fc.commission_amount::text AS commission_amount,
           UPPER(COALESCE(fc.commission_currency_code, fc.currency_code, 'USD')) AS currency
      FROM factory_containers fc
     WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL AND COALESCE(fc.commission_amount, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM vouchers v
          WHERE v.company_id = fc.company_id AND ${LIVE}
            AND (v.voucher_number = 'FACTORY-COMM-' || fc.id::text
                 OR v.voucher_number LIKE 'FACTORY-COMM-' || fc.id::text || '-%'))
     ORDER BY fc.id
  `);
  checks.push(
    check(
      "factory_container_commission_not_journalled",
      unjournalledCommission.length ? "warn" : "pass",
      unjournalledCommission.length,
      "Containers whose commission has no FACTORY-COMM journal: legacy containers, or a commission with no confirmed rate or no payee. The factory supplier memo lists them; they are not back-filled.",
      unjournalledCommission
    )
  );
  return {};
}
