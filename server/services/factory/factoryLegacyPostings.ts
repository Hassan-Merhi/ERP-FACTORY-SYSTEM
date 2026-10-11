/**
 * Reviewed back-fill of legacy factory postings (accounting audit phase 28,
 * F10 and F11; owner decision 2026-10-11: back-fill through the engine, dated
 * at the original date when its period is open, else at the cut-over date).
 *
 * Four families were listed (integrity diagnostic, not-in-ledger memo) but
 * never posted:
 *
 *   v3Loads        V3 stock-allocation loads finalized before wave 17 B: bales
 *                  SOLD, no invoice, so no receivable, revenue or cost of
 *                  sales. Back-fill: the invoice the finalize now writes
 *                  (finalizeV3LoadTx with legacyInvoiceDate: customer_orders
 *                  row, lines, customer_balances SALE row, INV-GL by the
 *                  factory invoice rules), dated with the load's finalize date.
 *   commissions    containers carrying a commission with no FACTORY-COMM
 *                  journal. Back-fill: syncContainerCommissionJournalTx (the
 *                  journal every container write now posts), dated with the
 *                  container date. A commission with no rate or no payee is
 *                  listed as blocked.
 *   imports        containers with goods and no FACTORY-IMPORT journal
 *                  (Dr Factory Import Cost / Cr the container's supplier, as
 *                  container create posts it) at the confirmed factory rate on
 *                  or before the container date. PENDING containers post when
 *                  they are confirmed and opening-balance containers carry no
 *                  import journal by design: both are listed as excluded; a
 *                  container with no supplier, no goods value or no confirmed
 *                  rate is listed as blocked.
 *   noTargetLines  FACTORY-FREIGHT and FACTORY-OC vouchers with a line that has
 *                  no target (no account, party, bank or asset): that amount is
 *                  in no balance. Back-fill: the voucher is retired (soft
 *                  delete, kept as history, number and identity released) and
 *                  posted again through the engine with the line on Factory
 *                  Freight Expense (FREIGHT) or Factory Other Charges Expense
 *                  (OC) — the freight / charge expense the line was meant to
 *                  debit; the container's freight account is used instead when
 *                  it is an expense account other than the paying account. A
 *                  non-USD voucher is listed as blocked (manual review).
 *
 * Date rule (decided by default): the original date when it is after the
 * company's closed-books date; otherwise the perpetual-inventory cut-over
 * date (else the factory receivable cut-over date) when that is open; else
 * the day after the closed-books date. Each item shows its posting date.
 *
 *   GET  plan  (Admin/Owner): per family the items to post (with amounts and
 *        dates), the blocked and excluded ones with the reason, a plan hash.
 *   POST apply (Owner, confirm + plan hash, optional `families`): one
 *        transaction under an advisory lock, the plan recomputed (409
 *        PLAN_CHANGED), every item posted through the engine, one audit row
 *        with every item and its voucher, in the same transaction.
 *
 * Run the plan before the perpetual-inventory opening: a container journal
 * dated before the cut-over and posted after the opening was applied is not
 * in the opening's factory goods in transit.
 */
import crypto from "node:crypto";

import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { systemAccountIdsTx } from "../accounting/perpetualInventory/linkedJournal";
import { companyClosedThrough } from "../accounting/scheduledPostingScope";
import { retireVouchersTx } from "../accounting/voucherRetirement";
import { containerCommissionRate, syncContainerCommissionJournalTx } from "./containerCommissionJournal";
import { findFactoryFxRateOnOrBefore, normalizeFactoryCurrency } from "./factoryFxRateOnDate";
import { postFactoryVoucherTx, type FactoryVoucherLine } from "./factoryVoucherPosting";
import { finalizeV3LoadTx } from "./v3LoadInvoice";

export const LEGACY_POSTING_FAMILIES = ["v3Loads", "commissions", "imports", "noTargetLines"] as const;
export type LegacyPostingFamily = (typeof LEGACY_POSTING_FAMILIES)[number];

export const LEGACY_POSTINGS_MESSAGES = {
  PLAN_CHANGED:
    "The legacy factory postings changed since they were reviewed. Preview them again and confirm the new plan.",
  NOTHING_TO_APPLY: "There is no legacy factory posting to back-fill.",
} as const;

export class LegacyPostingsRefusal extends HttpError {
  constructor(readonly code: keyof typeof LEGACY_POSTINGS_MESSAGES) {
    super(409, LEGACY_POSTINGS_MESSAGES[code]);
    this.name = "LegacyPostingsRefusal";
  }
  get body() {
    return { code: this.code, message: this.message };
  }
}

export interface LegacyPostingItem {
  family: LegacyPostingFamily;
  /** The load, container or voucher id. */
  id: number;
  reference: string;
  originalDate: string;
  postingDate: string;
  currency: string;
  amount: string;
  detail?: Record<string, unknown>;
}

export interface LegacyPostingSkip {
  family: LegacyPostingFamily;
  id: number;
  reference: string;
  reason: string;
}

export interface LegacyPostingsPlan {
  companyId: number;
  closedThrough: string | null;
  items: LegacyPostingItem[];
  blocked: LegacyPostingSkip[];
  excluded: LegacyPostingSkip[];
  totals: Record<LegacyPostingFamily, { items: number; blocked: number; excluded: number }>;
  planHash: string;
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

const addDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The posting date of a back-filled item (see the module comment). */
export async function legacyPostingDate(
  executor: DatabaseOrTransaction,
  companyId: number,
  originalDate: string,
  closedThrough: string | null
): Promise<string> {
  if (closedThrough === null || originalDate > closedThrough) return originalDate;
  const [cut] = await rows<{ date: string | null }>(
    executor,
    sql`SELECT COALESCE(
          (SELECT effective_from FROM gl_inventory_cutovers WHERE company_id = ${companyId}),
          (SELECT effective_from FROM factory_ar_cutovers WHERE company_id = ${companyId})
        )::text AS date`
  );
  if (cut?.date && cut.date > closedThrough) return cut.date;
  return addDay(closedThrough);
}

/** Read-only: the plan (see the module comment). */
export async function planLegacyFactoryPostings(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<LegacyPostingsPlan> {
  const closedThrough = await companyClosedThrough(companyId, executor);
  const items: LegacyPostingItem[] = [];
  const blocked: LegacyPostingSkip[] = [];
  const excluded: LegacyPostingSkip[] = [];
  const dated = (date: string) => legacyPostingDate(executor, companyId, date, closedThrough);

  // F10: V3 loads finalized with no invoice.
  for (const load of await rows<{ id: number; load_name: string; date: string; bales: number }>(
    executor,
    sql`
      SELECT l.id, l.load_name, COALESCE(l.finalized_at, l.created_at)::date::text AS date,
             (SELECT COUNT(*) FROM factory_v3_load_bales lb WHERE lb.load_id = l.id AND lb.removed_at IS NULL)::int AS bales
        FROM factory_v3_loads l
       WHERE l.company_id = ${companyId} AND l.status = 'finalized' AND l.customer_order_id IS NULL
       ORDER BY l.id
    `
  )) {
    if (load.bales === 0) {
      excluded.push({ family: "v3Loads", id: load.id, reference: load.load_name, reason: "no bales" });
      continue;
    }
    items.push({
      family: "v3Loads",
      id: Number(load.id),
      reference: load.load_name,
      originalDate: load.date,
      postingDate: await dated(load.date),
      currency: "USD",
      amount: "0.00",
      detail: { bales: load.bales },
    });
  }

  // F11: commissions with no FACTORY-COMM journal.
  for (const container of await rows<{
    id: number;
    container_number: string;
    date: string;
    currency_code: string | null;
    fx_rate_to_usd: string | null;
    fx_rate_confirmed: boolean | null;
    commission_amount: string;
    commission_currency_code: string | null;
    commission_fx_rate_to_usd: string | null;
    commission_fx_rate_confirmed: boolean | null;
    payee: boolean;
  }>(
    executor,
    sql`
      SELECT fc.id, fc.container_number, COALESCE(fc.arrival_date, fc.created_at::date)::text AS date,
             fc.currency_code, fc.fx_rate_to_usd::text AS fx_rate_to_usd, fc.fx_rate_confirmed,
             fc.commission_amount::text AS commission_amount, fc.commission_currency_code,
             fc.commission_fx_rate_to_usd::text AS commission_fx_rate_to_usd, fc.commission_fx_rate_confirmed,
             (fc.commission_supplier_id IS NOT NULL OR fc.supplier_id IS NOT NULL OR fc.commission_account_id IS NOT NULL)
               AS payee
        FROM factory_containers fc
       WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL AND COALESCE(fc.commission_amount, 0) > 0
         AND NOT EXISTS (
           SELECT 1 FROM vouchers v WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
              AND v.voucher_number ~ ('^FACTORY-COMM-' || fc.id::text || '(-|$)')
         )
       ORDER BY fc.id
    `
  )) {
    const { currency, rate } = containerCommissionRate(container);
    if (!rate) {
      blocked.push({
        family: "commissions",
        id: container.id,
        reference: container.container_number,
        reason: "no confirmed rate",
      });
      continue;
    }
    if (!container.payee) {
      blocked.push({
        family: "commissions",
        id: container.id,
        reference: container.container_number,
        reason: "no payee",
      });
      continue;
    }
    items.push({
      family: "commissions",
      id: Number(container.id),
      reference: container.container_number,
      originalDate: container.date,
      postingDate: await dated(container.date),
      currency,
      amount: toMoney(container.commission_amount).toFixed(2),
    });
  }

  // F11: containers with goods and no FACTORY-IMPORT journal.
  for (const container of await rows<{
    id: number;
    container_number: string;
    status: string | null;
    date: string;
    currency_code: string | null;
    supplier_id: number | null;
    goods: string;
  }>(
    executor,
    sql`
      SELECT fc.id, fc.container_number, fc.status, COALESCE(fc.arrival_date, fc.created_at::date)::text AS date,
             fc.currency_code, fc.supplier_id,
             (COALESCE(fc.rate_per_kg, 0) * COALESCE(fc.total_kg, 0))::text AS goods
        FROM factory_containers fc
       WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vouchers v WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
              AND v.voucher_number LIKE ('FACTORY-IMPORT-' || fc.id::text || '-%')
         )
       ORDER BY fc.id
    `
  )) {
    const skip = { family: "imports" as const, id: Number(container.id), reference: container.container_number };
    const status = String(container.status ?? "").toUpperCase();
    if (status === "PENDING") {
      excluded.push({ ...skip, reason: "pending: posted when the container is confirmed" });
      continue;
    }
    if (status === "OPENING_BALANCE") {
      excluded.push({ ...skip, reason: "opening balance: no import journal by design" });
      continue;
    }
    const goods = toMoney(container.goods).toDecimalPlaces(2);
    if (!goods.gt(0)) {
      excluded.push({ ...skip, reason: "no goods value" });
      continue;
    }
    if (!container.supplier_id) {
      blocked.push({ ...skip, reason: "no supplier" });
      continue;
    }
    const currency = normalizeFactoryCurrency(container.currency_code);
    const rate = await findFactoryFxRateOnOrBefore(executor, companyId, currency, container.date);
    if (!rate) {
      blocked.push({ ...skip, reason: `no confirmed ${currency} rate on or before ${container.date}` });
      continue;
    }
    items.push({
      ...skip,
      originalDate: container.date,
      postingDate: await dated(container.date),
      currency,
      amount: goods.toFixed(2),
      detail: { supplierId: Number(container.supplier_id), rate: rate.rate },
    });
  }

  // F11: freight / other-charge lines with no target.
  for (const voucher of await rows<{
    id: number;
    voucher_number: string;
    voucher_date: string;
    currency: string | null;
    container_id: number | null;
    family: string;
    amount: string;
  }>(
    executor,
    sql`
      SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.currency,
             substring(v.voucher_number FROM '^FACTORY-(?:FREIGHT|OC)-([0-9]+)')::int AS container_id,
             substring(v.voucher_number FROM '^FACTORY-(FREIGHT|OC)-') AS family,
             SUM(ve.debit_amount + ve.credit_amount)::text AS amount
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
         AND v.voucher_number ~ '^FACTORY-(FREIGHT|OC)-[0-9]+'
         AND ve.ledger_account_id IS NULL AND ve.customer_id IS NULL AND ve.supplier_id IS NULL
         AND ve.employee_id IS NULL AND ve.bank_account_id IS NULL AND ve.factory_supplier_id IS NULL
         AND ve.fixed_asset_id IS NULL
       GROUP BY v.id
       ORDER BY v.id
    `
  )) {
    const skip = { family: "noTargetLines" as const, id: Number(voucher.id), reference: voucher.voucher_number };
    if (normalizeFactoryCurrency(voucher.currency) !== "USD") {
      blocked.push({ ...skip, reason: "not USD: review by hand" });
      continue;
    }
    items.push({
      ...skip,
      originalDate: voucher.voucher_date,
      postingDate: await dated(voucher.voucher_date),
      currency: "USD",
      amount: toMoney(voucher.amount).toFixed(2),
      detail: { containerId: voucher.container_id, kind: voucher.family },
    });
  }

  const totals = Object.fromEntries(
    LEGACY_POSTING_FAMILIES.map((family) => [
      family,
      {
        items: items.filter((item) => item.family === family).length,
        blocked: blocked.filter((item) => item.family === family).length,
        excluded: excluded.filter((item) => item.family === family).length,
      },
    ])
  ) as LegacyPostingsPlan["totals"];
  const planHash = crypto.createHash("sha256").update(JSON.stringify({ companyId, items, blocked })).digest("hex");
  return { companyId, closedThrough, items, blocked, excluded, totals, planHash };
}

/** Re-posts a FACTORY-FREIGHT/OC voucher with its target-less line on the expense account. */
async function retargetVoucherTx(
  tx: DbTransaction,
  companyId: number,
  item: LegacyPostingItem,
  actor: { userId: string; username: string }
): Promise<number> {
  const [voucher] = await rows<{ voucher_type: string; description: string | null; source_module: string | null }>(
    tx,
    sql`SELECT voucher_type, description, source_module FROM vouchers
         WHERE id = ${item.id} AND company_id = ${companyId} FOR UPDATE`
  );
  const lines = await rows<{
    ledger_account_id: number | null;
    customer_id: number | null;
    supplier_id: number | null;
    employee_id: number | null;
    bank_account_id: number | null;
    factory_supplier_id: number | null;
    fixed_asset_id: number | null;
    debit_amount: string;
    credit_amount: string;
    narration: string | null;
  }>(
    tx,
    sql`SELECT ledger_account_id, customer_id, supplier_id, employee_id, bank_account_id, factory_supplier_id,
               fixed_asset_id, debit_amount::text AS debit_amount, credit_amount::text AS credit_amount, narration
          FROM voucher_entries WHERE voucher_id = ${item.id} ORDER BY id`
  );
  const kind = String(item.detail?.kind ?? "FREIGHT");
  const containerId = item.detail?.containerId == null ? null : Number(item.detail.containerId);
  const code = kind === "OC" ? "FACTORY_OC_EXPENSE" : "FACTORY_FREIGHT_EXPENSE";
  let expenseId = (await systemAccountIdsTx(tx, companyId, [code])).get(code)!;
  if (kind === "FREIGHT" && containerId !== null) {
    // The container's freight account, when it is an expense account other than the paying account.
    const [container] = await rows<{ account_id: number | null }>(
      tx,
      sql`SELECT la.id AS account_id FROM factory_containers fc
            JOIN ledger_accounts la ON la.id = fc.freight_account_id AND la.company_id = ${companyId}
                                   AND la.deleted_at IS NULL AND la.account_type ILIKE '%expense%'
           WHERE fc.id = ${containerId} AND fc.company_id = ${companyId}
             AND fc.freight_account_id IS DISTINCT FROM fc.freight_own_account_id`
    );
    if (container?.account_id) expenseId = Number(container.account_id);
  }
  const target = (line: (typeof lines)[number]) =>
    line.ledger_account_id ??
    line.customer_id ??
    line.supplier_id ??
    line.employee_id ??
    line.bank_account_id ??
    line.factory_supplier_id ??
    line.fixed_asset_id;
  const posted: FactoryVoucherLine[] = lines.map((line) => ({
    ledgerAccountId: target(line) == null ? expenseId : line.ledger_account_id,
    customerId: line.customer_id,
    supplierId: line.supplier_id,
    employeeId: line.employee_id,
    bankAccountId: line.bank_account_id,
    factorySupplierId: line.factory_supplier_id,
    fixedAssetId: line.fixed_asset_id,
    debit: line.debit_amount,
    credit: line.credit_amount,
    narration: target(line) == null ? `${line.narration ?? "Freight"} (target restored)` : line.narration,
  }));
  await retireVouchersTx(tx, {
    companyId,
    voucherIds: [item.id],
    reason: "factory-no-target-line-retarget",
    actor,
  });
  const familyPrefix = item.reference.match(/^FACTORY-(?:FREIGHT|OC)-[0-9]+/)?.[0] ?? `FACTORY-${kind}`;
  const { voucher: reposted } = await postFactoryVoucherTx(tx, {
    companyId,
    voucherType: voucher?.voucher_type ?? "Journal",
    voucherNumber: `${familyPrefix}-R${item.id}`,
    voucherDate: item.postingDate,
    description: `${voucher?.description ?? item.reference} (re-posted with its ${kind === "OC" ? "charge" : "freight"} expense account)`,
    currency: "USD",
    sourceModule: voucher?.source_module ?? "FACTORY",
    source: { sourceType: "factory-no-target-line-retarget", sourceId: item.id, phase: "voucher" },
    lines: posted,
  });
  return reposted.id;
}

export interface LegacyPostingsResult {
  plan: LegacyPostingsPlan;
  posted: Array<{ family: LegacyPostingFamily; id: number; voucherId: number | null; skipped?: string }>;
}

export async function applyLegacyFactoryPostings(
  companyId: number,
  params: { planHash: string; families?: LegacyPostingFamily[]; actor: { userId: string; username: string } }
): Promise<LegacyPostingsResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_legacy_postings'), ${companyId})`);
    const plan = await planLegacyFactoryPostings(companyId, tx);
    if (plan.planHash !== params.planHash) throw new LegacyPostingsRefusal("PLAN_CHANGED");
    const families = new Set(params.families?.length ? params.families : LEGACY_POSTING_FAMILIES);
    const selected = plan.items.filter((item) => families.has(item.family));
    if (selected.length === 0) throw new LegacyPostingsRefusal("NOTHING_TO_APPLY");
    const importCostId = (await systemAccountIdsTx(tx, companyId, ["FACTORY_IMPORT_COST"])).get("FACTORY_IMPORT_COST")!;
    const posted: LegacyPostingsResult["posted"] = [];
    for (const item of selected) {
      if (item.family === "v3Loads") {
        const result = await finalizeV3LoadTx(tx, {
          companyId,
          loadId: item.id,
          user: { id: params.actor.userId, name: params.actor.username },
          statementDate: item.postingDate,
          legacyInvoiceDate: item.postingDate,
        });
        posted.push({
          family: item.family,
          id: item.id,
          voucherId: null,
          ...(result.invoice ? {} : { skipped: "no invoice" }),
        });
      } else if (item.family === "commissions") {
        const result = await syncContainerCommissionJournalTx(tx, companyId, item.id, {
          voucherDate: item.postingDate,
        });
        posted.push({
          family: item.family,
          id: item.id,
          voucherId: result.voucherId,
          ...(result.skipped ? { skipped: result.skipped } : {}),
        });
      } else if (item.family === "imports") {
        const amount = toMoney(item.amount);
        const { voucher } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `FACTORY-IMPORT-${item.id}-${generation}`,
          voucherDate: item.postingDate,
          description: `Goods import - container ${item.reference} (reviewed back-fill)`,
          currency: item.currency,
          fxRateToUsd: String(item.detail?.rate ?? "1"),
          source: { sourceType: "factory-container-import", sourceId: item.id, phase: "goods" },
          lines: [
            {
              ledgerAccountId: importCostId,
              debit: amount,
              narration: `Goods import cost - container ${item.reference}`,
            },
            {
              factorySupplierId: Number(item.detail?.supplierId),
              credit: amount,
              narration: `Goods payable to supplier - container ${item.reference}`,
            },
          ],
        });
        posted.push({ family: item.family, id: item.id, voucherId: voucher.id });
      } else {
        posted.push({
          family: item.family,
          id: item.id,
          voucherId: await retargetVoucherTx(tx, companyId, item, params.actor),
        });
      }
    }
    const total = selected.reduce((sum, item) => sum.plus(item.amount), new MoneyDecimal(0));
    await writeAuditEvent(
      {
        userId: params.actor.userId,
        username: params.actor.username,
        companyId,
        action: "create",
        tableName: "vouchers",
        recordId: companyId,
        recordIdentifier: "factory-legacy-postings",
        changes: {
          backfill: {
            old: null,
            new: {
              planHash: plan.planHash,
              families: [...families],
              total: total.toFixed(2),
              items: selected.map((item) => ({
                family: item.family,
                id: item.id,
                reference: item.reference,
                postingDate: item.postingDate,
                amount: item.amount,
                voucherId:
                  posted.find((entry) => entry.family === item.family && entry.id === item.id)?.voucherId ?? null,
              })),
            },
          },
        },
      },
      tx
    );
    return { plan, posted };
  });
}
