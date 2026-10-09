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
 *     Before the opening nothing is posted (no half-books). Sale COGS is
 *     unchanged.
 * (c) The reconciliation (retailInventoryReconciliationTx) compares the
 *     ledger and the sub-ledger; the perpetual reconciliation, the readiness
 *     report and the integrity diagnostic show it.
 */
import { createHash } from "node:crypto";

import type Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { retailAccountingSettings, retailInventoryOpenings, retailVariantInventory } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { ensureRetailAccountingSettingsTx } from "./retailFinancialService";
import {
  cents,
  postRetailJournalTx,
  retailSystemAccountIdTx,
  type RetailJournalActor,
  type RetailJournalLine,
} from "./retailLedgerPosting";

export const RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT = "RETAIL-INVENTORY-ADJUSTMENT";
export const RETAIL_GRNI_ACCOUNT = "RETAIL-GRNI";
export const OPENING_EQUITY_ACCOUNT = "OPENING_BALANCE_EQUITY";
export const retailInventoryOpeningVoucherNumber = (companyId: number) => `RETAIL-INV-OPEN-${companyId}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

// ---------------------------------------------------------------------------
// Opening

export const RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES = {
  RETAIL_INVENTORY_OPENING_ALREADY_APPLIED: "The Retail inventory opening has already been applied for this company.",
  RETAIL_INVENTORY_OPENING_PLAN_CHANGED:
    "The Retail inventory opening changed since it was reviewed; review it again before applying.",
  RETAIL_INVENTORY_OPENING_LATER_DOCUMENTS:
    "Retail stock documents are dated after the chosen opening date. Choose a later opening date.",
  RETAIL_INVENTORY_OPENING_FUTURE_DATE: "The Retail inventory opening date cannot be in the future.",
} as const;
export type RetailInventoryOpeningRefusalCode = keyof typeof RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES;

export class RetailInventoryOpeningRefusal extends HttpError {
  constructor(readonly code: RetailInventoryOpeningRefusalCode) {
    super(code === "RETAIL_INVENTORY_OPENING_FUTURE_DATE" ? 400 : 409, RETAIL_INVENTORY_OPENING_REFUSAL_MESSAGES[code]);
    this.name = "RetailInventoryOpeningRefusal";
  }
  get body() {
    return { code: this.code, message: this.message };
  }
}

export async function retailInventoryOpeningTx(executor: DatabaseOrTransaction, companyId: number) {
  const [opening] = await executor
    .select()
    .from(retailInventoryOpenings)
    .where(eq(retailInventoryOpenings.companyId, companyId))
    .limit(1);
  return opening ?? null;
}

/** Exact Σ quantity × average_cost of the company's Retail stock rows. */
export async function retailStockSubLedgerValue(executor: DatabaseOrTransaction, companyId: number) {
  const [row] = await rows<{ value: string; rows: number; negative_rows: number }>(
    executor,
    sql`SELECT COALESCE(SUM(quantity * average_cost), 0)::text AS value, COUNT(*)::int AS rows,
               COUNT(*) FILTER (WHERE quantity < 0)::int AS negative_rows
          FROM retail_variant_inventory WHERE company_id = ${companyId}`
  );
  return { value: toMoney(row?.value ?? 0), rows: row?.rows ?? 0, negativeRows: row?.negative_rows ?? 0 };
}

/** The Retail inventory accounts of the company: every account its Retail settings rows name. */
async function retailInventoryAccountIds(executor: DatabaseOrTransaction, companyId: number): Promise<number[]> {
  const found = await executor
    .selectDistinct({ id: retailAccountingSettings.inventoryAssetLedgerAccountId })
    .from(retailAccountingSettings)
    .where(eq(retailAccountingSettings.companyId, companyId));
  return found.map((row) => row.id).filter((id): id is number => typeof id === "number");
}

/** Σ signed opening + debit − credit of live, non-optional lines on the accounts (voucher date ≤ asOf when given). */
async function ledgerBalanceOf(
  executor: DatabaseOrTransaction,
  companyId: number,
  accountIds: number[],
  asOf?: string
): Promise<Decimal> {
  if (!accountIds.length) return new MoneyDecimal(0);
  const ids = sql.join(
    accountIds.map((id) => sql`${id}`),
    sql`, `
  );
  const [lines] = await rows<{ net: string }>(
    executor,
    sql`SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::text AS net
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND ve.ledger_account_id IN (${ids})
           ${asOf ? sql`AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}` : sql``}`
  );
  const [opening] = await rows<{ net: string }>(
    executor,
    sql`SELECT COALESCE(SUM(CASE WHEN opening_balance_side = 'Cr' THEN -opening_balance ELSE opening_balance END), 0)::text AS net
          FROM ledger_accounts WHERE company_id = ${companyId} AND id IN (${ids})`
  );
  return toMoney(lines?.net ?? 0).plus(toMoney(opening?.net ?? 0));
}

/** Retail stock movements dated after `dateISO` in the company's timezone. */
async function movementsAfter(executor: DatabaseOrTransaction, companyId: number, dateISO: string): Promise<number> {
  const [row] = await rows<{ count: number }>(
    executor,
    sql`SELECT COUNT(*)::int AS count
          FROM retail_stock_movements m
          LEFT JOIN company_settings cs ON cs.company_id = m.company_id
         WHERE m.company_id = ${companyId}
           AND (m.created_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(NULLIF(cs.timezone, ''), 'UTC'))::date > ${dateISO}::date`
  );
  return row?.count ?? 0;
}

export interface RetailInventoryOpeningPlan {
  companyId: number;
  openingDate: string;
  subLedgerValue: string;
  stockRows: number;
  negativeRows: number;
  inventoryAccountId: number;
  inventoryAccountIds: number[];
  equityAccountId: number;
  ledgerBalance: string;
  /** Sub-ledger value less ledger balance: posted Dr inventory / Cr equity when positive. */
  amount: string;
  laterDocuments: number;
  alreadyApplied: { openingDate: string; voucherId: number | null } | null;
  blockers: RetailInventoryOpeningRefusalCode[];
  planHash: string;
}

/** The opening plan, in the caller's transaction (it resolves the Retail default accounts). */
export async function planRetailInventoryOpeningTx(
  tx: DbTransaction,
  companyId: number,
  openingDate: string
): Promise<RetailInventoryOpeningPlan> {
  if (!ISO_DATE.test(openingDate)) throw new HttpError(400, "Invalid date");
  const settings = await ensureRetailAccountingSettingsTx(tx, companyId, null);
  const inventoryAccountIds = [
    ...new Set([settings.inventoryAssetLedgerAccountId, ...(await retailInventoryAccountIds(tx, companyId))]),
  ].sort((a, b) => a - b);
  const equityAccountId = await retailSystemAccountIdTx(tx, companyId, OPENING_EQUITY_ACCOUNT);
  const stock = await retailStockSubLedgerValue(tx, companyId);
  const ledger = await ledgerBalanceOf(tx, companyId, inventoryAccountIds);
  const subLedgerValue = cents(stock.value);
  const ledgerBalance = cents(ledger);
  const amount = subLedgerValue.minus(ledgerBalance);
  const laterDocuments = await movementsAfter(tx, companyId, openingDate);
  const existing = await retailInventoryOpeningTx(tx, companyId);
  const today = await companyBusinessDate(companyId, tx);
  const blockers: RetailInventoryOpeningRefusalCode[] = [];
  if (existing) blockers.push("RETAIL_INVENTORY_OPENING_ALREADY_APPLIED");
  if (openingDate > today) blockers.push("RETAIL_INVENTORY_OPENING_FUTURE_DATE");
  if (laterDocuments > 0) blockers.push("RETAIL_INVENTORY_OPENING_LATER_DOCUMENTS");
  const [last] = await rows<{ id: number | null }>(
    tx,
    sql`SELECT MAX(id) AS id FROM retail_stock_movements WHERE company_id = ${companyId}`
  );
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        companyId,
        openingDate,
        subLedgerValue: subLedgerValue.toFixed(2),
        ledgerBalance: ledgerBalance.toFixed(2),
        amount: amount.toFixed(2),
        inventoryAccountId: settings.inventoryAssetLedgerAccountId,
        inventoryAccountIds,
        equityAccountId,
        lastMovementId: last?.id ?? null,
      })
    )
    .digest("hex");
  return {
    companyId,
    openingDate,
    subLedgerValue: subLedgerValue.toFixed(2),
    stockRows: stock.rows,
    negativeRows: stock.negativeRows,
    inventoryAccountId: settings.inventoryAssetLedgerAccountId,
    inventoryAccountIds,
    equityAccountId,
    ledgerBalance: ledgerBalance.toFixed(2),
    amount: amount.toFixed(2),
    laterDocuments,
    alreadyApplied: existing ? { openingDate: String(existing.openingDate), voucherId: existing.voucherId } : null,
    blockers,
    planHash,
  };
}

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

export interface RetailStockKey {
  variantId: number;
  locationId: number;
}

export type RetailStockJournalKind =
  "receipt" | "intake" | "import" | "product" | "adjustment" | "transfer" | "return" | "cancel" | "count";

const keyOf = (key: RetailStockKey) => `${key.variantId}:${key.locationId}`;

async function rowValues(tx: DbTransaction, companyId: number, keys: RetailStockKey[]) {
  const values = new Map<string, Decimal>();
  for (const key of keys) {
    const [row] = await tx
      .select({ quantity: retailVariantInventory.quantity, averageCost: retailVariantInventory.averageCost })
      .from(retailVariantInventory)
      .where(
        and(
          eq(retailVariantInventory.companyId, companyId),
          eq(retailVariantInventory.variantId, key.variantId),
          eq(retailVariantInventory.locationId, key.locationId)
        )
      )
      .limit(1);
    values.set(keyOf(key), row ? toMoney(row.quantity).times(toMoney(row.averageCost)) : new MoneyDecimal(0));
  }
  return values;
}

/** A source id that fits a voucher number: as given up to 60 characters, else a 24-hex digest of it. */
export function retailStockSourceId(raw: string | number): string {
  const text = String(raw);
  return text.length <= 60 ? text : createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export interface RetailStockValueTracker {
  /** Takes the value of more rows before the writer changes them (rows already taken are kept). */
  include(keys: RetailStockKey[]): Promise<void>;
  /**
   * Journals the value the writer moved since the tracker was taken. `contra`
   * lines are signed (debit positive): a receipt credits RETAIL-GRNI with the
   * purchase value. `alreadyDebited` is what another journal of the same
   * document already put on the inventory account (a refund's restored
   * cost). The rest goes to RETAIL-INVENTORY-ADJUSTMENT. Null before the
   * opening, or when nothing moved.
   */
  post(input: {
    kind: RetailStockJournalKind;
    sourceId: string | number;
    description: string;
    actor: RetailJournalActor;
    contra?: { accountCode: string; amount: Decimal; narration: string }[];
    alreadyDebited?: Decimal;
  }): Promise<number | null>;
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

export interface RetailInventoryReconciliation {
  companyId: number;
  applicable: boolean;
  opening: { openingDate: string; voucherId: number | null } | null;
  inventoryAccountIds: number[];
  ledger: string;
  subLedger: string;
  difference: string;
  stockRows: number;
}

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
