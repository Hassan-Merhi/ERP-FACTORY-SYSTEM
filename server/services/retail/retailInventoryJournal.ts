/**
 * RETAIL-INVENTORY connected to the Retail stock sub-ledger (accounting audit
 * wave 17 D, owner decision 3 of 2026-10-09).
 *
 * Before: only the sale's COGS line (credit) and refunds (debit) touched
 * RETAIL-INVENTORY; no receipt, adjustment, transfer, import or opening did,
 * so the account drifted negative by the cost of everything sold.
 *
 * Sub-ledger value: Σ quantity × average_cost of the company's
 * retail_variant_inventory rows (exact, rounded to cents at the total).
 *
 * (a) Opening. An Owner preview/apply (plan hash, confirm, one transaction,
 *     audit) posts RETAIL-INV-OPEN-{company} on the chosen opening date: the
 *     sub-ledger value less what the Retail inventory account(s) already hold,
 *     Dr RETAIL-INVENTORY / Cr Opening Balance Equity (registry account) — or
 *     the reverse when the ledger holds more. A date with later-dated Retail
 *     stock movements (by the company's timezone), or a future date, is
 *     refused, like the ERP cut-over.
 * (b) From the opening on, every Retail stock writer journals the value it
 *     moved, in its own transaction (trackRetailStockValueTx): the change of
 *     the touched rows' value (after − before, from the stored quantity and
 *     average cost) against the writer's contra — receipts and new-item
 *     intake: RETAIL-GRNI at quantity × unit cost (Retail receipts name no
 *     supplier); adjustments, imports and product stock edits:
 *     RETAIL-INVENTORY-ADJUSTMENT; transfers: none (the destination takes the
 *     source's cost, so the value moves between locations); returns and
 *     cancellations: what their refund journal already debited. Whatever the
 *     contra does not explain (re-costing, cent rounding) goes to
 *     RETAIL-INVENTORY-ADJUSTMENT. Deterministic voucher numbers
 *     RETAIL-STK-{KIND}-{source} and identities `retail-stock-{kind}:{source}`.
 *     Before the opening nothing is posted (no half-books), including sale
 *     COGS/asset entries. Sales still settle into cash/customer and revenue,
 *     with cost retained on sale lines for operational profit reporting.
 * (c) The reconciliation (retailInventoryReconciliationTx) compares the
 *     ledger and the sub-ledger; the perpetual reconciliation, the readiness
 *     report and the integrity diagnostic show it.
 */
import { createHash } from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { retailInventoryOpenings } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { ensureRetailAccountingSettingsTx } from "./retailFinancialService";
import {
  cents,
  postRetailJournalTx,
  retailSystemAccountIdTx,
  type RetailJournalActor,
  type RetailJournalLine,
} from "./retailLedgerPosting";
import {
  RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT,
  RetailInventoryOpeningRefusal,
  ledgerBalanceOf,
  planRetailInventoryOpeningTx,
  retailInventoryAccountIds,
  retailInventoryOpeningTx,
  retailInventoryOpeningVoucherNumber,
  retailStockSubLedgerValue,
  rows,
} from "./planRetailInventoryOpeningTx";
import {
  keyOf,
  rowValues,
  type RetailStockKey,
  type RetailStockValueTracker,
  type RetailInventoryReconciliation,
} from "./retailInventoryJournalHelpers";
export type {
  RetailStockKey,
  RetailStockJournalKind,
  RetailStockValueTracker,
  RetailInventoryReconciliation,
} from "./retailInventoryJournalHelpers";
export {
  OPENING_EQUITY_ACCOUNT,
  RETAIL_GRNI_ACCOUNT,
  RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT,
  RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES,
  RETAIL_IN_TRANSIT_ACCOUNT,
  RetailInventoryOpeningRefusal,
  planRetailInventoryOpeningTx,
  retailInventoryOpeningTx,
  retailInventoryOpeningVoucherNumber,
  retailStockSubLedgerValue,
} from "./planRetailInventoryOpeningTx";
export type { RetailInventoryOpeningPlan, RetailInventoryOpeningRefusalCode } from "./planRetailInventoryOpeningTx";

export async function previewRetailInventoryOpening(companyId: number, openingDate: string) {
  return db.transaction((tx) => planRetailInventoryOpeningTx(tx, companyId, openingDate));
}

/**
 * Applies the reviewed plan in one transaction: the Retail stock rows are
 * share-locked (no stock write can interleave), the plan is recomputed and
 * must match `planHash`, the opening journal is posted (none when the amount
 * is zero), the opening row and its audit are written.
 */
export async function applyRetailInventoryOpening(
  companyId: number,
  input: { openingDate: string; planHash: string; actor: RetailJournalActor }
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE retail_variant_inventory IN SHARE MODE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${2026_10_174}, ${companyId})`);
    const plan = await planRetailInventoryOpeningTx(tx, companyId, input.openingDate);
    if (plan.blockers.length) throw new RetailInventoryOpeningRefusal(plan.blockers[0]);
    if (plan.planHash !== input.planHash)
      throw new RetailInventoryOpeningRefusal("RETAIL_INVENTORY_OPENING_PLAN_CHANGED");
    const amount = toMoney(plan.amount);
    const voucherId = await postRetailJournalTx(tx, {
      companyId,
      voucherNumber: retailInventoryOpeningVoucherNumber(companyId),
      sourceType: "retail-inventory-opening",
      sourceId: String(companyId),
      description: `Retail inventory opening at ${plan.openingDate}: stock ${plan.subLedgerValue}, ledger ${plan.ledgerBalance}`,
      voucherDate: plan.openingDate,
      lines: [
        { ledgerAccountId: plan.inventoryAccountId, amount, narration: "Retail stock sub-ledger value at the opening" },
        { ledgerAccountId: plan.equityAccountId, amount: amount.negated(), narration: "Retail inventory opening" },
      ],
      actor: input.actor,
      reason: "Retail inventory opening",
    });
    const [opening] = await tx
      .insert(retailInventoryOpenings)
      .values({
        companyId,
        openingDate: plan.openingDate,
        voucherId,
        subLedgerValue: plan.subLedgerValue,
        ledgerBalanceBefore: plan.ledgerBalance,
        amount: plan.amount,
        planHash: plan.planHash,
        appliedBy: input.actor.userId,
      })
      .returning();
    await writeAuditEvent(
      {
        userId: input.actor.userId,
        username: input.actor.username ?? input.actor.userId,
        companyId,
        action: "create",
        tableName: "retail_inventory_openings",
        recordId: opening.id,
        recordIdentifier: `Retail inventory opening ${plan.openingDate}`,
        changes: {
          openingDate: { new: plan.openingDate },
          subLedgerValue: { new: plan.subLedgerValue },
          ledgerBalanceBefore: { new: plan.ledgerBalance },
          amount: { new: plan.amount },
          voucherId: { new: voucherId },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, blockers: [], applied: true, voucherId, alreadyApplied: null };
  });
}

// ---------------------------------------------------------------------------
// Stock writers

/** A source id that fits a voucher number: as given up to 60 characters, else a 24-hex digest of it. */
export function retailStockSourceId(raw: string | number): string {
  const text = String(raw);
  return text.length <= 60 ? text : createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/**
 * Takes the value of the rows a stock writer is about to change (call it after
 * locking them, before the change), and returns the tracker that journals the
 * change. Before the opening is applied the tracker does nothing.
 */
export async function trackRetailStockValueTx(
  tx: DbTransaction,
  companyId: number,
  keys: RetailStockKey[]
): Promise<RetailStockValueTracker> {
  const opening = await retailInventoryOpeningTx(tx, companyId);
  if (!opening) return { include: async () => {}, post: async () => null };
  const unique: RetailStockKey[] = [];
  const before = new Map<string, Decimal>();
  const include = async (more: RetailStockKey[]) => {
    const fresh = [...new Map(more.map((key) => [keyOf(key), key])).values()].filter((key) => !before.has(keyOf(key)));
    if (!fresh.length) return;
    for (const [key, value] of await rowValues(tx, companyId, fresh)) before.set(key, value);
    unique.push(...fresh);
  };
  await include(keys);
  return {
    include,
    async post(input) {
      const sourceId = retailStockSourceId(input.sourceId);
      const after = await rowValues(tx, companyId, unique);
      const deltaByLocation = new Map<number, Decimal>();
      for (const key of unique) {
        const delta = (after.get(keyOf(key)) ?? new MoneyDecimal(0)).minus(before.get(keyOf(key)) ?? 0);
        deltaByLocation.set(key.locationId, (deltaByLocation.get(key.locationId) ?? new MoneyDecimal(0)).plus(delta));
      }
      const lines: RetailJournalLine[] = [];
      let defaultInventory: number | null = null;
      for (const [locationId, delta] of [...deltaByLocation.entries()].sort((a, b) => a[0] - b[0])) {
        const settings = await ensureRetailAccountingSettingsTx(tx, companyId, locationId);
        defaultInventory ??= settings.inventoryAssetLedgerAccountId;
        lines.push({
          ledgerAccountId: settings.inventoryAssetLedgerAccountId,
          amount: cents(delta),
          narration: `Retail stock ${input.kind} #${sourceId} · location ${locationId}`,
        });
      }
      if (input.alreadyDebited && defaultInventory) {
        lines.push({
          ledgerAccountId: defaultInventory,
          amount: cents(input.alreadyDebited).negated(),
          narration: `Retail stock ${input.kind} #${sourceId} · already journalled`,
        });
      }
      for (const contra of input.contra ?? []) {
        lines.push({
          ledgerAccountId: await retailSystemAccountIdTx(tx, companyId, contra.accountCode),
          amount: cents(contra.amount),
          narration: contra.narration,
        });
      }
      const residual = lines.reduce((acc, line) => acc.plus(line.amount), new MoneyDecimal(0)).negated();
      if (!residual.isZero()) {
        lines.push({
          ledgerAccountId: await retailSystemAccountIdTx(tx, companyId, RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT),
          amount: residual,
          narration: `Retail stock ${input.kind} #${sourceId} · adjustment`,
        });
      }
      return postRetailJournalTx(tx, {
        companyId,
        locationId: unique.length === 1 ? unique[0].locationId : null,
        voucherNumber: `RETAIL-STK-${input.kind.toUpperCase()}-${sourceId}`,
        sourceType: `retail-stock-${input.kind}`,
        sourceId,
        description: input.description,
        lines,
        actor: input.actor,
        reason: `Retail stock ${input.kind}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation

/** RETAIL-INVENTORY (every Retail inventory account) against the Retail stock sub-ledger (today's value). */
export async function retailInventoryReconciliationTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf?: string
): Promise<RetailInventoryReconciliation> {
  const accountIds = await retailInventoryAccountIds(executor, companyId);
  const [code] = await rows<{ id: number }>(
    executor,
    sql`SELECT id FROM ledger_accounts WHERE company_id = ${companyId} AND code = 'RETAIL-INVENTORY' LIMIT 1`
  );
  const ids = [...new Set([...accountIds, ...(code ? [code.id] : [])])].sort((a, b) => a - b);
  const stock = await retailStockSubLedgerValue(executor, companyId);
  const ledger = cents(await ledgerBalanceOf(executor, companyId, ids, asOf));
  const subLedger = cents(stock.value);
  const opening = await retailInventoryOpeningTx(executor, companyId);
  return {
    companyId,
    applicable: stock.rows > 0 || ids.length > 0,
    opening: opening ? { openingDate: String(opening.openingDate), voucherId: opening.voucherId } : null,
    inventoryAccountIds: ids,
    ledger: ledger.toFixed(2),
    subLedger: subLedger.toFixed(2),
    difference: ledger.minus(subLedger).toFixed(2),
    stockRows: stock.rows,
  };
}
