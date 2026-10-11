/**
 * Reviewed repair of legacy voucher lines the ledger guards never reached
 * (accounting audit phase 23, G7; production P4–P7).
 *
 * The wave 4 guards stop new cases, but older lines remain: lines on a
 * ledger account that was hard-deleted (orphans), on a soft-deleted account,
 * on another company's account, and lines with no target at all. Their
 * amounts sit in balanced vouchers yet in no live account of the company, so
 * every report misses them. This Owner tool moves them, by reclassification
 * JOURNALS — the original lines are never edited or deleted:
 *
 *   - planLegacyLineRepair (read-only): every such line of a live voucher of
 *     the company, grouped by kind and source, the reclassification each group
 *     gets, blockers and a sha256 plan hash;
 *   - applyLegacyLineRepair: current company only, one transaction (company
 *     scope, advisory lock), the plan derived again and applied only when its
 *     hash is the reviewed one. For an orphan account a placeholder ledger
 *     account is restored with the missing id (inactive, named after the
 *     lines; the voucher_entries foreign key can then be validated). One
 *     journal (infrastructure writer: a line with no target cannot pass the
 *     engine's one-target rule) reverses each group's net on
 *     its source (the placeholder, the deleted or other-company account, or no
 *     target) and posts it to the destination account; it is dated on the
 *     company's business date (a closed period refuses it). Each line is
 *     recorded in legacy_line_repairs (once) and one audit row holds the plan
 *     and the journal. The reversing lines name a target the guard refuses for
 *     new lines, so they are written under the guard's reviewed-repair bypass
 *     for this transaction only;
 *   - validateLedgerGuardConstraints: tries `VALIDATE CONSTRAINT` on each NOT
 *     VALID ledger constraint in its own savepoint and reports which passed
 *     (a constraint other companies' rows still break stays NOT VALID).
 *
 * Decided by default (owner can override): the destination is the company's
 * SUSPENSE system account ("Suspense (Legacy Line Repair)") for the owner to
 * reclassify with an ordinary journal once each amount is understood; a
 * `targetLedgerAccountId` of the company (a live leaf account) can be given
 * instead.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { voucherEntries } from "@shared/schema";

import type { VoucherEntryInsertFields } from "./accountingTypes";
import { companyBusinessDate } from "./companyBusinessDate";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "./infrastructureVoucherIdentity";
import { LEDGER_ACCOUNT_PARENT_FK, LEDGER_GUARD_CONSTRAINTS } from "./ledgerIntegrityGuard";
import { systemAccountIdsTx } from "./perpetualInventory/linkedJournal";

export const LEGACY_LINE_REPAIR_SOURCE_TYPE = "legacy-line-repair";
const ZERO = new MoneyDecimal(0);

export type LegacyLineKind = "orphanAccount" | "deletedAccount" | "crossCompanyAccount" | "noTarget";

export const LEGACY_LINE_REPAIR_MESSAGES = {
  NOTHING_TO_REPAIR: "There is no legacy line to repair in this company.",
  TARGET_INVALID: "The destination must be a live, active leaf ledger account of this company.",
  PLAN_CHANGED: "The legacy lines changed since they were reviewed; review the plan again.",
} as const;

export type LegacyLineRepairRefusalCode = keyof typeof LEGACY_LINE_REPAIR_MESSAGES;

export class LegacyLineRepairRefusal extends Error {
  constructor(readonly code: LegacyLineRepairRefusalCode) {
    super(LEGACY_LINE_REPAIR_MESSAGES[code]);
    this.name = "LegacyLineRepairRefusal";
  }
  get status(): number {
    return this.code === "TARGET_INVALID" ? 400 : 409;
  }
}

export interface LegacyLineGroup {
  kind: LegacyLineKind;
  /** The account the lines name (null for lines with no target). */
  sourceLedgerAccountId: number | null;
  sourceName: string;
  entryIds: number[];
  /** Net of the lines, debit positive, to the cent. */
  net: string;
}

export interface LegacyLineRepairPlan {
  companyId: number;
  voucherDate: string;
  destination: { ledgerAccountId: number | null; code: string | null; name: string | null };
  groups: LegacyLineGroup[];
  journal: { source: string; debit: string; credit: string }[];
  totals: { lines: number; debit: string; credit: string };
  blockers: LegacyLineRepairRefusalCode[];
  planHash: string;
}

interface LegacyLineRow {
  entry_id: number;
  kind: LegacyLineKind;
  ledger_account_id: number | null;
  account_name: string | null;
  net: string;
}

async function rowsOf<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await executor.execute(query);
  return result.rows as unknown as T[];
}

/** Every legacy line of a live voucher of the company not repaired yet. */
async function legacyLines(executor: DatabaseOrTransaction, companyId: number): Promise<LegacyLineRow[]> {
  return rowsOf<LegacyLineRow>(
    executor,
    // Under row-level security another company's account is invisible here
    // (the tenant scope), so ownership of the accounts not visible is read by
    // the narrow erp_ledger_account_owners probe (ledgerModelSchema.ts): a line
    // on another company's account is crossCompanyAccount, never an orphan.
    sql`
    WITH candidates AS (
      SELECT ve.id AS entry_id, ve.ledger_account_id, v.company_id AS voucher_company_id,
             la.id AS visible_id, la.company_id AS visible_company_id, la.deleted_at IS NOT NULL AS visible_deleted,
             la.name AS account_name,
             (COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0))::text AS net
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE v.company_id = ${companyId}
         AND v.deleted_at IS NULL
         AND v.optional = false
         AND NOT EXISTS (SELECT 1 FROM legacy_line_repairs r WHERE r.entry_id = ve.id)
         -- The reversing lines of a repair journal are its own, not legacy lines.
         AND NOT EXISTS (SELECT 1 FROM legacy_line_repairs r WHERE r.repair_voucher_id = v.id)
         AND (
           (ve.ledger_account_id IS NOT NULL
             AND (la.id IS NULL OR la.company_id IS DISTINCT FROM v.company_id OR la.deleted_at IS NOT NULL))
           OR num_nonnulls(ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id,
                           ve.employee_id, ve.customer_id, ve.factory_supplier_id) = 0
         )
    ), owners AS (
      SELECT * FROM erp_ledger_account_owners(
        ARRAY(SELECT DISTINCT c.ledger_account_id FROM candidates c
               WHERE c.ledger_account_id IS NOT NULL AND c.visible_id IS NULL)
      )
    )
    SELECT c.entry_id,
           CASE
             WHEN c.ledger_account_id IS NOT NULL AND c.visible_id IS NULL AND o.account_id IS NULL THEN 'orphanAccount'
             WHEN c.ledger_account_id IS NOT NULL
                  AND COALESCE(c.visible_company_id, o.company_id) IS DISTINCT FROM c.voucher_company_id
               THEN 'crossCompanyAccount'
             WHEN c.ledger_account_id IS NOT NULL AND COALESCE(c.visible_deleted, o.deleted) THEN 'deletedAccount'
             ELSE 'noTarget'
           END AS kind,
           c.ledger_account_id,
           c.account_name,
           c.net
      FROM candidates c
      LEFT JOIN owners o ON o.account_id = c.ledger_account_id
     ORDER BY c.entry_id`
  );
}

async function destinationOf(
  executor: DatabaseOrTransaction,
  companyId: number,
  targetLedgerAccountId: number | null
): Promise<{ ledgerAccountId: number | null; code: string | null; name: string | null; valid: boolean }> {
  const [row] = await rowsOf<{ id: number; code: string; name: string; postable: boolean }>(
    executor,
    targetLedgerAccountId
      ? sql`SELECT la.id, la.code, la.name,
                   (la.deleted_at IS NULL AND la.active
                    AND lower(btrim(COALESCE(la.sub_type, ''))) <> 'group'
                    AND NOT EXISTS (SELECT 1 FROM ledger_accounts c WHERE c.parent_id = la.id AND c.deleted_at IS NULL))
                     AS postable
              FROM ledger_accounts la WHERE la.id = ${targetLedgerAccountId} AND la.company_id = ${companyId}`
      : sql`SELECT la.id, la.code, la.name, true AS postable
              FROM ledger_accounts la
             WHERE la.company_id = ${companyId} AND la.code = 'SUSPENSE' AND la.deleted_at IS NULL LIMIT 1`
  );
  if (!row) {
    // SUSPENSE is created by the apply when missing; an explicit id must exist.
    return targetLedgerAccountId
      ? { ledgerAccountId: targetLedgerAccountId, code: null, name: null, valid: false }
      : { ledgerAccountId: null, code: "SUSPENSE", name: "Suspense (Legacy Line Repair)", valid: true };
  }
  return { ledgerAccountId: Number(row.id), code: row.code, name: row.name, valid: row.postable === true };
}

const money = (value: Decimal) => value.toFixed(2);

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  targetLedgerAccountId: number | null
): Promise<LegacyLineRepairPlan> {
  const blockers: LegacyLineRepairRefusalCode[] = [];
  const destination = await destinationOf(executor, companyId, targetLedgerAccountId);
  if (!destination.valid) blockers.push("TARGET_INVALID");

  const lines = await legacyLines(executor, companyId);
  const groups = new Map<string, LegacyLineGroup>();
  for (const line of lines) {
    const key = `${line.kind}:${line.ledger_account_id ?? "-"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: line.kind,
        sourceLedgerAccountId: line.ledger_account_id === null ? null : Number(line.ledger_account_id),
        sourceName:
          line.kind === "noTarget"
            ? "Lines with no account"
            : line.kind === "orphanAccount"
              ? `Missing account #${line.ledger_account_id}`
              : `${line.account_name ?? "Account"} (#${line.ledger_account_id})`,
        entryIds: [],
        net: "0.00",
      };
      groups.set(key, group);
    }
    group.entryIds.push(Number(line.entry_id));
    group.net = money(toMoney(group.net).plus(toMoney(line.net)));
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || (a.sourceLedgerAccountId ?? 0) - (b.sourceLedgerAccountId ?? 0)
  );
  if (ordered.length === 0) blockers.push("NOTHING_TO_REPAIR");

  // Each group's net is reversed on its source and posted to the destination.
  const journal: LegacyLineRepairPlan["journal"] = [];
  let destinationNet = ZERO;
  for (const group of ordered) {
    const net = toMoney(group.net);
    if (net.isZero()) continue;
    destinationNet = destinationNet.plus(net);
    journal.push({
      source: group.sourceName,
      debit: money(net.isNegative() ? net.negated() : ZERO),
      credit: money(net.isPositive() ? net : ZERO),
    });
  }
  if (!destinationNet.isZero()) {
    journal.push({
      source: destination.name ?? "Destination",
      debit: money(destinationNet.isPositive() ? destinationNet : ZERO),
      credit: money(destinationNet.isNegative() ? destinationNet.negated() : ZERO),
    });
  }
  const debit = journal.reduce((sum, line) => sum.plus(line.debit), ZERO);
  const credit = journal.reduce((sum, line) => sum.plus(line.credit), ZERO);
  const body = {
    companyId,
    voucherDate: await companyBusinessDate(companyId, executor),
    destination: { ledgerAccountId: destination.ledgerAccountId, code: destination.code, name: destination.name },
    groups: ordered,
    journal,
    totals: { lines: lines.length, debit: money(debit), credit: money(credit) },
    blockers,
  };
  return { ...body, planHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/** Read-only plan for the company. */
export function planLegacyLineRepair(
  companyId: number,
  options: { targetLedgerAccountId?: number | null } = {},
  executor: DatabaseOrTransaction = db
): Promise<LegacyLineRepairPlan> {
  return derivePlan(executor, companyId, options.targetLedgerAccountId ?? null);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export function applyLegacyLineRepair(
  companyId: number,
  options: {
    planHash: string;
    targetLedgerAccountId?: number | null;
    actor: { userId: string; username: string };
  }
): Promise<LegacyLineRepairPlan & { voucherId: number | null; restoredPlaceholders: number[] }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LEGACY_LINE_REPAIR_SOURCE_TYPE}), ${companyId})`);
    const plan = await derivePlan(tx, companyId, options.targetLedgerAccountId ?? null);
    if (plan.planHash !== options.planHash) throw new LegacyLineRepairRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new LegacyLineRepairRefusal(plan.blockers[0]);

    const destinationId =
      plan.destination.ledgerAccountId ?? (await systemAccountIdsTx(tx, companyId, ["SUSPENSE"])).get("SUSPENSE")!;

    // Orphan accounts: restore an inactive placeholder with the missing id, so
    // the lines have an account again and the foreign key can be validated.
    const restoredPlaceholders: number[] = [];
    for (const group of plan.groups.filter((g) => g.kind === "orphanAccount")) {
      const id = group.sourceLedgerAccountId!;
      await tx.execute(sql`
        INSERT INTO ledger_accounts (id, company_id, code, name, account_type, active, is_hidden, opening_balance)
        VALUES (${id}, ${companyId}, ${`LEGACY-ORPHAN-${id}`},
                ${`Restored account #${id} (legacy lines of a deleted account)`}, 'Liability', false, false, 0)
        ON CONFLICT (id) DO NOTHING`);
      restoredPlaceholders.push(id);
    }

    const entries: VoucherEntryInsertFields[] = [];
    let destinationNet = ZERO;
    for (const group of plan.groups) {
      const net = toMoney(group.net);
      if (net.isZero()) continue;
      destinationNet = destinationNet.plus(net);
      entries.push({
        ...(group.sourceLedgerAccountId === null ? {} : { ledgerAccountId: group.sourceLedgerAccountId }),
        debitAmount: money(net.isNegative() ? net.negated() : ZERO),
        creditAmount: money(net.isPositive() ? net : ZERO),
        narration: `Legacy line repair: reverses ${group.entryIds.length} line(s) on ${group.sourceName}`,
      });
    }
    let voucherId: number | null = null;
    if (!destinationNet.isZero() || entries.length > 0) {
      if (!destinationNet.isZero()) {
        entries.push({
          ledgerAccountId: destinationId,
          debitAmount: money(destinationNet.isPositive() ? destinationNet : ZERO),
          creditAmount: money(destinationNet.isNegative() ? destinationNet.negated() : ZERO),
          narration: `Legacy line repair: amounts of ${plan.totals.lines} legacy line(s)`,
        });
      }
      // The reversing lines name a target new lines may not (a deleted or
      // other-company account, or none), and a line with no target cannot pass
      // the engine's one-target rule, so the journal is written by the
      // infrastructure writer (posting identity, header, closed-period and
      // balance guards in the database, as the fiscal close's journal) under
      // the ledger guard's reviewed-repair bypass for this transaction only.
      await tx.execute(sql`SELECT set_config('app.ledger_integrity_bypass', 'on', true)`);
      const voucherNumber = `LEGACY-REPAIR-${companyId}-${plan.planHash.slice(0, 12)}`;
      const { voucher: posted } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: plan.voucherDate,
          totalAmount: plan.totals.debit,
          description: "Reclassification of legacy lines on missing, deleted or other-company accounts",
          currency: "USD",
          exchangeRate: "1",
          sourceModule: "ERP",
          optional: false,
        },
        infrastructurePostingIdentity(LEGACY_LINE_REPAIR_SOURCE_TYPE, `${companyId}:${plan.planHash}`),
        { entries }
      );
      await tx.insert(voucherEntries).values(entries.map((entry) => ({ ...entry, voucherId: posted.id })));
      await tx.execute(sql`SELECT set_config('app.ledger_integrity_bypass', '', true)`);
      voucherId = Number(posted.id);
    }

    for (const group of plan.groups) {
      for (const entryId of group.entryIds) {
        await tx.execute(sql`
          INSERT INTO legacy_line_repairs (company_id, entry_id, kind, repair_voucher_id, target_ledger_account_id,
                                           placeholder_ledger_account_id, plan_hash, applied_by_user_id)
          VALUES (${companyId}, ${entryId}, ${group.kind}, ${voucherId}, ${destinationId},
                  ${group.kind === "orphanAccount" ? group.sourceLedgerAccountId : null}, ${plan.planHash},
                  ${options.actor.userId})`);
      }
    }

    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "create",
        tableName: "legacy_line_repairs",
        recordId: voucherId,
        recordIdentifier: "legacy-line-repair",
        changes: {
          legacyLines: { old: plan.groups, new: plan.groups.map((g) => ({ ...g, reclassifiedBy: voucherId })) },
          reclassificationJournal: { old: null, new: { voucherId, journal: plan.journal, destinationId } },
          restoredPlaceholders: { new: restoredPlaceholders },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, voucherId, restoredPlaceholders };
  });
}

export interface ConstraintValidationResult {
  constraint: string;
  table: string;
  validated: boolean;
  alreadyValid: boolean;
  error?: string;
}

/**
 * Tries VALIDATE CONSTRAINT on each ledger guard constraint still NOT VALID,
 * each in its own savepoint: one that existing rows still break stays NOT
 * VALID (it keeps checking every new row) and is reported.
 */
export async function validateLedgerGuardConstraints(
  pool: Pick<Pool, "connect">
): Promise<ConstraintValidationResult[]> {
  const wanted: { table: string; constraint: string }[] = [
    ...LEDGER_GUARD_CONSTRAINTS.map((constraint) => ({ table: "voucher_entries", constraint })),
    { table: "ledger_accounts", constraint: LEDGER_ACCOUNT_PARENT_FK },
  ];
  const client = await pool.connect();
  const results: ConstraintValidationResult[] = [];
  try {
    for (const { table, constraint } of wanted) {
      const state = await client.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)`,
        [constraint, table]
      );
      if (state.rows.length === 0) {
        results.push({ constraint, table, validated: false, alreadyValid: false, error: "constraint missing" });
        continue;
      }
      if (state.rows[0].convalidated) {
        results.push({ constraint, table, validated: true, alreadyValid: true });
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        // Names come from the fixed list above, never from input.
        await client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`);
        await client.query("COMMIT");
        results.push({ constraint, table, validated: true, alreadyValid: false });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        results.push({
          constraint,
          table,
          validated: false,
          alreadyValid: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    client.release();
  }
  return results;
}
