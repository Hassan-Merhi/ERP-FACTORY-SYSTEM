/**
 * Opening inventory journal for the perpetual-inventory cut-over (wave 8).
 *
 * Under the periodic method the stock on hand was never in the ledger: its cost
 * went to expense when it was bought. At the cut-over that stock is
 * capitalised once, dated the eve of the cut-over:
 *
 *   Dr Goods in Transit              purchase cost of POs not yet offloaded
 *   Dr Inventory                     ERP stock sub-ledger as of the eve: SUM of
 *                                    inventory.total_value, replayed from the
 *                                    stored values (stockValuation, wave 11),
 *                                    signed (negative stock at its provisional
 *                                    value), so the reconciliation starts at zero
 *   Dr Factory Raw Material Stock    remaining kg × landed USD cost per kg
 *   Dr Factory Work in Progress      open mix-batch kg × mix cost per kg,
 *                                    plus bales awaiting pressing
 *   Dr Factory Finished Goods        bales held, at their recorded cost
 *   Dr Factory Goods in Transit      the expensed cost of factory containers
 *                                    not yet received (wave 17 B, below)
 *      Cr Opening Balance Equity     the total
 *
 * Each line posts the difference between that value and what the ledger
 * already holds on the account as of the eve (credit and debit notes have
 * always posted to Inventory), so nothing already in the ledger is counted
 * twice; a line whose ledger balance exceeds its value credits the account.
 * A supplier-partner company's Goods in Transit and Inventory are left alone.
 *
 * The plan is read-only. Rows that carry no cost are listed, never valued at a
 * guess. Applying requires an Owner, PERPETUAL_INVENTORY_POSTING_READY, and a
 * cut-over date that is today or earlier (the factory figures are current
 * values; the ERP figure is computed as of the eve), with no document yet
 * posted on or after that date (it would carry none of its perpetual-inventory
 * postings). Applying computes the plan inside its own transaction (repeatable
 * read, after taking the company's cut-over lock), so the journal posts the
 * figures of one consistent snapshot, and records the cut-over in the same
 * transaction, once per company.
 *
 * Wave 15 apply guards (owner decision 2, re-audit M3). The apply is refused
 * (409) while, for the company:
 *   - any stock sits on a location that no longer exists, or any row holds a
 *     value outside the valuation policy (READINESS_BLOCKERS): the opening
 *     would leave the first out and capitalise the second. They are resolved
 *     through the reviewed readiness resolution first. A supplier-partner
 *     company's ERP stock is not capitalised, so it is not checked.
 *   - any document is dated on or after the cut-over date: a voucher, an
 *     offload (the container's offload date, else the offload's own date), a
 *     factory container receipt, or a stock movement that leaves no document
 *     line (inventory_value_movements). Each would carry none of its
 *     perpetual-inventory postings.
 * The plan lists the purchase orders the Goods in Transit line carries
 * (`goodsInTransitPurchaseOrderIds`), so a later stock-in journal credits Goods
 * in Transit only for what the opening put there (carriedByOpening).
 *
 * Wave 17 B apply guard (decision 6, factoryCutoverBlockers.ts): also refused
 * (FACTORY_READINESS_BLOCKERS) while factory raw-stock rows or bales carry no
 * USD cost, open mixes have no USD rate, stock bales with no mix are costed at
 * the catalogue price (decision 2), or legacy factory foreign-currency lines
 * are unrepaired (the wave 6 repair plan's count). The message gives the
 * counts; the readiness report shows the same figures.
 *
 * Factory goods in transit (wave 17 B, re-audit HIGH). The factory books a
 * container's cost to expense when its FACTORY- vouchers post (import,
 * commission, freight, other charges), before the raw material arrives; the
 * daily factory stock journal capitalises a receipt by crediting those expense
 * accounts. For a container expensed before the cut-over and received after
 * it, that credit would reduce the new period's expense for a cost of the old
 * one. The approach is the ERP one (goods in transit carried by the opening,
 * cleared by the receipt): the opening debits FACTORY_GOODS_IN_TRANSIT, per
 * container not fully received at the eve (factory status not OFFLOADED), with
 * what its FACTORY- vouchers dated before the cut-over debited to expense less
 * the USD value of its receipts dated before the cut-over (when positive), and
 * lists it (`factoryGoodsInTransit`); the daily factory journal credits Factory
 * Goods in Transit with a later receipt of that container up to what the
 * opening carried, and only the rest against the expense accounts. A carried
 * amount the receipts never use (a short container) stays in Factory Goods in
 * Transit, where the reconciliation shows it.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { planReadinessResolutionTx } from "../../inventory/inventoryReadinessResolution";
import { companyStockValuationAsOf } from "../../inventory/stockValuation";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "../infrastructureVoucherIdentity";
import { ensureSystemAccounts } from "../systemAccounts";
import { ledgerBalancesByCode } from "./linkedJournal";
import { factoryStockValuation, type UnvaluedRow } from "./factoryValuation";
import { factoryCutoverBlockerMessage, factoryCutoverBlockers } from "./factoryCutoverBlockers";
import { DEFAULT_PERPETUAL_INVENTORY_FROM, PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";

export interface OpeningJournalLine {
  accountCode: string;
  /** What the account should hold at the cut-over. */
  target: string;
  /** What the ledger already holds on the account as of the eve (debit positive). */
  ledgerBalance: string;
  /** What the journal posts: target minus ledger balance (positive debits the account). */
  amount: string;
  basis: string;
}

export type { UnvaluedRow } from "./factoryValuation";

export interface OpeningInventoryPlan {
  companyId: number;
  effectiveFrom: string;
  /** The journal's date: the eve of the cut-over. */
  journalDate: string;
  lines: OpeningJournalLine[];
  total: string;
  unvalued: UnvaluedRow[];
  /** Bales already marked sold on orders that are not finalized: shipped but not yet invoiced. */
  soldNotInvoiced: { bales: number; cost: string };
  /**
   * The ERP stock behind the INVENTORY target, as of the eve (2dp text):
   * stock in hand (negative stock not subtracting), the provisional value of
   * negative stock, and values on rows outside the valuation policy. The
   * target is their sum, the signed sub-ledger. Null for a supplier partner.
   */
  erpStock: { stockInHand: string; shortageValue: string; otherValues: string; subLedgerTotal: string } | null;
  /** Supplier-partner company: ERP stock is carried in sp_stock and not capitalised here. */
  supplierPartner: boolean;
  /** The purchase orders the Goods in Transit line carries (dated before the cut-over, not offloaded by then). */
  goodsInTransitPurchaseOrderIds: number[];
  /** Factory containers the Factory Goods in Transit line carries, with the amount (wave 17 B). */
  factoryGoodsInTransit: Array<{ containerId: number; amount: string }>;
  alreadyApplied: boolean;
  postingReady: boolean;
}

export class OpeningJournalRefusal extends Error {
  constructor(
    readonly code:
      | "POSTING_NOT_READY"
      | "ALREADY_APPLIED"
      | "CUTOVER_IN_FUTURE"
      | "DOCUMENTS_ON_OR_AFTER_CUTOVER"
      | "READINESS_BLOCKERS"
      | "FACTORY_READINESS_BLOCKERS"
      | "INVALID_DATE",
    message: string
  ) {
    super(message);
    this.name = "OpeningJournalRefusal";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

/** The opening journal's debit side: the lines it debits, and equity when the lines net to a credit. */
function openingDebitTotal(plan: Pick<OpeningInventoryPlan, "lines" | "total">): Decimal {
  const debits = plan.lines.reduce(
    (sum, line) => (toMoney(line.amount).isPositive() ? sum.plus(line.amount) : sum),
    new MoneyDecimal(0)
  );
  const net = toMoney(plan.total);
  return net.isNegative() ? debits.plus(net.negated()) : debits;
}

/** Read-only: the opening inventory journal for one company. */
export async function planOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string = DEFAULT_PERPETUAL_INVENTORY_FROM,
  executor: DatabaseOrTransaction = db
): Promise<OpeningInventoryPlan> {
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const journalDate = dayBefore(effectiveFrom);
  // Supplier-partner companies carry their stock in their own sp_stock
  // accounts already; their ERP stock is not capitalised a second time.
  const company = await rows<{ company_type: string | null }>(
    executor,
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company[0]?.company_type === "supplier_partner";
  // The signed ERP sub-ledger as of the eve (the policy is stockValuation's:
  // every non-deleted location, active or not, bale mirror left out).
  const valuation = supplierPartner ? null : await companyStockValuationAsOf(executor, companyId, journalDate);
  const erpStock = toMoney(valuation?.subLedgerTotal ?? 0);
  const erpStockDetail = valuation && {
    stockInHand: valuation.total,
    shortageValue: valuation.excluded.shortageValue,
    otherValues: toMoney(valuation.excluded.shortRowValue).plus(valuation.excluded.negativeValue).toFixed(2),
    subLedgerTotal: valuation.subLedgerTotal,
  };

  const factory = await factoryStockValuation(executor, companyId);
  const { unvalued } = factory;
  const rawValue = factory.raw;
  const wipValue = factory.wip;
  const finishedValue = factory.finished;

  // Goods in transit on the eve: what Purchases absorbed for POs dated before
  // the cut-over whose container had not been offloaded by then. Their stock
  // arrives after the cut-over, and STOCK-IN credits goods in transit for them.
  const transit = supplierPartner
    ? []
    : await rows<{ purchases: string; purchase_order_ids: number[] | null }>(
        executor,
        sql`
        SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS purchases,
               array_agg(DISTINCT po.id ORDER BY po.id) AS purchase_order_ids
          FROM purchase_orders po
          JOIN containers c ON c.id = po.container_id AND c.company_id = po.company_id
          JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                             AND COALESCE(v.optional, false) = false
          JOIN voucher_entries ve ON ve.voucher_id = v.id
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'PURCHASES'
         WHERE po.company_id = ${companyId} AND v.voucher_date < ${effectiveFrom}
           AND (c.offload_date IS NULL OR c.offload_date >= ${effectiveFrom})
      `
      );
  const goodsInTransit = toMoney(transit[0]?.purchases ?? 0).toDecimalPlaces(2);
  const goodsInTransitPurchaseOrderIds = (transit[0]?.purchase_order_ids ?? []).map(Number);
  const factoryGoodsInTransit = await factoryGoodsInTransitAtEve(executor, companyId, effectiveFrom);
  const factoryTransitTotal = factoryGoodsInTransit.reduce((sum, row) => sum.plus(row.amount), new MoneyDecimal(0));

  const targets: Array<{ accountCode: string; target: Decimal; basis: string }> = [
    // A supplier-partner company's ERP inventory accounts are left as they are.
    ...(supplierPartner
      ? []
      : [
          {
            accountCode: "GOODS_IN_TRANSIT",
            target: goodsInTransit,
            basis: "purchase cost of POs not yet offloaded",
          },
          {
            accountCode: "INVENTORY",
            target: erpStock.toDecimalPlaces(2),
            basis: `ERP stock sub-ledger (total_value) as of ${journalDate}`,
          },
        ]),
    {
      accountCode: "FACTORY_RAW_MATERIAL_STOCK",
      target: rawValue.toDecimalPlaces(2),
      basis: "remaining kg × landed USD cost per kg",
    },
    {
      accountCode: "FACTORY_WIP",
      target: wipValue.toDecimalPlaces(2),
      basis: "open mix-batch kg × mix cost per kg, and bales awaiting pressing",
    },
    {
      accountCode: "FACTORY_FINISHED_GOODS",
      target: finishedValue.toDecimalPlaces(2),
      basis: "bales held, at their recorded cost",
    },
    {
      accountCode: "FACTORY_GOODS_IN_TRANSIT",
      target: factoryTransitTotal.toDecimalPlaces(2),
      basis: "expensed cost of factory containers not yet received",
    },
  ];

  // What the ledger already holds on these accounts as of the eve: their
  // opening balances and every active posting (credit and debit notes, for
  // one, have always posted to Inventory). The journal posts only the
  // difference, so nothing already in the ledger is counted twice.
  const ledgerBalance = await ledgerBalancesByCode(
    executor,
    companyId,
    targets.map((line) => line.accountCode),
    journalDate
  );
  const lines: OpeningJournalLine[] = targets
    .map((line) => {
      const balance = ledgerBalance.get(line.accountCode) ?? new MoneyDecimal(0);
      return {
        accountCode: line.accountCode,
        target: line.target.toFixed(2),
        ledgerBalance: balance.toFixed(2),
        amount: line.target.minus(balance).toFixed(2),
        basis: line.basis,
      };
    })
    .filter((line) => !toMoney(line.amount).isZero());
  const total = lines.reduce((sum, line) => sum.plus(line.amount), new MoneyDecimal(0));

  return {
    companyId,
    effectiveFrom,
    journalDate,
    lines,
    total: total.toFixed(2),
    unvalued,
    soldNotInvoiced: factory.soldNotInvoiced,
    erpStock: erpStockDetail,
    supplierPartner,
    goodsInTransitPurchaseOrderIds,
    factoryGoodsInTransit: factoryGoodsInTransit.map((row) => ({
      containerId: row.containerId,
      amount: row.amount.toFixed(2),
    })),
    alreadyApplied: (await getInventoryCutover(executor, companyId)) !== null,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
  };
}

/**
 * Factory goods in transit on the eve (see the module comment): per factory
 * container not fully received, what its FACTORY- vouchers dated before the
 * cut-over debited to expense less the USD value of its receipts dated before
 * it, when positive.
 */
export async function factoryGoodsInTransitAtEve(
  executor: DatabaseOrTransaction,
  companyId: number,
  effectiveFrom: string
): Promise<Array<{ containerId: number; amount: Decimal }>> {
  const found = await rows<{ container_id: number; expensed: string; received: string }>(
    executor,
    sql`
      WITH expensed AS (
        SELECT substring(v.voucher_number FROM '^FACTORY-(?:IMPORT|COMM|FREIGHT|OC|POC)-([0-9]+)(?:-|$)')::int
                 AS container_id,
               SUM(ve.debit_amount) AS amount
          FROM vouchers v
          JOIN voucher_entries ve ON ve.voucher_id = v.id AND ve.debit_amount > 0
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = ${companyId}
                                 AND la.account_type ILIKE '%expense%'
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND COALESCE(v.effective_date, v.voucher_date) < ${effectiveFrom}::date
           AND v.voucher_number ~ '^FACTORY-(IMPORT|COMM|FREIGHT|OC|POC)-[0-9]+(-|$)'
         GROUP BY 1
      )
      SELECT e.container_id, e.amount::text AS expensed,
             COALESCE((SELECT SUM(r.receipt_value_usd) FROM factory_container_receipts r
                        WHERE r.company_id = ${companyId} AND r.container_id = e.container_id
                          AND r.deleted_at IS NULL AND r.receipt_date < ${effectiveFrom}::date), 0)::text AS received
        FROM expensed e
        JOIN factory_containers fc ON fc.id = e.container_id AND fc.company_id = ${companyId}
       WHERE fc.deleted_at IS NULL AND COALESCE(fc.status, '') <> 'OFFLOADED'
       ORDER BY e.container_id
    `
  );
  return found
    .map((row) => ({
      containerId: Number(row.container_id),
      amount: toMoney(row.expensed).minus(toMoney(row.received)).toDecimalPlaces(2),
    }))
    .filter((row) => row.amount.gt(0));
}

/**
 * Refuses the cut-over while a document is dated on or after it (see the
 * module comment), listing what was found.
 */
export interface DocumentsOnOrAfterCutover {
  vouchers: number;
  offloads: number;
  factoryReceipts: number;
  stockMovements: number;
}

/** Read-only: what is already dated on or after a cut-over date (see the module comment). */
export async function documentsOnOrAfterCutover(
  executor: DatabaseOrTransaction,
  companyId: number,
  effectiveFrom: string
): Promise<DocumentsOnOrAfterCutover> {
  const [found] = await rows<{ vouchers: number; offloads: number; receipts: number; movements: number }>(
    executor,
    sql`
      SELECT
        (SELECT COUNT(*) FROM vouchers
          WHERE company_id = ${companyId} AND voucher_date >= ${effectiveFrom}::date AND deleted_at IS NULL)::int
          AS vouchers,
        (SELECT COUNT(*) FROM container_offloads co JOIN containers c ON c.id = co.container_id
          WHERE c.company_id = ${companyId}
            AND COALESCE(c.offload_date, co.offloaded_at::date) >= ${effectiveFrom}::date)::int AS offloads,
        (SELECT COUNT(*) FROM factory_container_receipts
          WHERE company_id = ${companyId} AND deleted_at IS NULL AND receipt_date >= ${effectiveFrom}::date)::int
          AS receipts,
        (SELECT COUNT(*) FROM inventory_value_movements
          WHERE company_id = ${companyId} AND movement_date >= ${effectiveFrom}::date)::int AS movements
    `
  );
  return {
    vouchers: found?.vouchers ?? 0,
    offloads: found?.offloads ?? 0,
    factoryReceipts: found?.receipts ?? 0,
    stockMovements: found?.movements ?? 0,
  };
}

async function assertNoDocumentsOnOrAfterTx(tx: DbTransaction, companyId: number, effectiveFrom: string) {
  const found = await documentsOnOrAfterCutover(tx, companyId, effectiveFrom);
  const counts = [
    ["vouchers", found.vouchers],
    ["offloads", found.offloads],
    ["factory container receipts", found.factoryReceipts],
    ["stock movements", found.stockMovements],
  ] as const;
  const present = counts.filter(([, count]) => count > 0);
  if (present.length > 0) {
    throw new OpeningJournalRefusal(
      "DOCUMENTS_ON_OR_AFTER_CUTOVER",
      `Documents are already posted on or after the cut-over date (${present
        .map(([label, count]) => `${count} ${label}`)
        .join(", ")}); choose a later date`
    );
  }
}

/**
 * Refuses the cut-over while stock sits on locations that no longer exist or
 * any row holds a value outside the valuation policy (owner decision 2).
 */
async function assertInventoryReadyTx(tx: DbTransaction, companyId: number) {
  const readiness = await planReadinessResolutionTx(tx, companyId);
  const { totals } = readiness;
  if (totals.orphanedRows > 0 || totals.anomalousRows > 0) {
    throw new OpeningJournalRefusal(
      "READINESS_BLOCKERS",
      `Inventory is not ready for the cut-over: ${totals.orphanedRows} rows (value ${totals.orphanedValue}) on ` +
        `${totals.orphanedLocations} locations that no longer exist and ${totals.anomalousRows} rows with ` +
        `anomalous values (${totals.anomalousValue}); resolve them with the inventory readiness resolution first`
    );
  }
}

/**
 * Posts the opening journal and records the cut-over, in one transaction.
 * `postingReady` exists for tests; the route always passes the real flag.
 */
export async function applyOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string,
  appliedBy: string,
  options: { postingReady?: boolean; today?: string } = {}
): Promise<{ plan: OpeningInventoryPlan; voucherId: number | null }> {
  if (!(options.postingReady ?? PERPETUAL_INVENTORY_POSTING_READY)) {
    throw new OpeningJournalRefusal(
      "POSTING_NOT_READY",
      "Perpetual inventory posting is not complete yet; the cut-over cannot be applied"
    );
  }
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (effectiveFrom > today) {
    throw new OpeningJournalRefusal("CUTOVER_IN_FUTURE", "The cut-over can be applied on or after its date");
  }

  // Repeatable read: the snapshot is taken at the lock statement, so an apply
  // that committed while this one waited for the lock is not visible to it;
  // the primary key refuses the second row, reported as ALREADY_APPLIED.
  const applied = await db
    .transaction(
      async (tx) => {
        // Serializes concurrent applies for the company; the primary key refuses a second row.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gl_inventory_cutover'), ${companyId})`);
        if (await getInventoryCutover(tx, companyId)) {
          throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
        }
        // The plan is built here, on this transaction's snapshot, so the journal
        // posts exactly the figures it records (a plan read before the lock could
        // be stale by the time it was posted).
        const plan = await planOpeningInventoryJournal(companyId, effectiveFrom, tx);
        // A document dated on or after the cut-over that was posted before it was
        // applied carries none of its perpetual-inventory postings; the cut-over is
        // applied before the first document of its date (or moved to a later date).
        await assertNoDocumentsOnOrAfterTx(tx, companyId, effectiveFrom);
        if (!plan.supplierPartner) await assertInventoryReadyTx(tx, companyId);
        // Wave 17 B (decision 6): unvalued factory rows, open mixes without a USD
        // rate, no-mix bales at the catalogue price, unrepaired legacy FX lines.
        const factoryBlocked = factoryCutoverBlockerMessage(await factoryCutoverBlockers(tx, companyId));
        if (factoryBlocked) throw new OpeningJournalRefusal("FACTORY_READINESS_BLOCKERS", factoryBlocked);
        let id: number | null = null;
        if (plan.lines.length > 0) {
          const codes = [...plan.lines.map((line) => line.accountCode), "OPENING_BALANCE_EQUITY"];
          const statuses = await ensureSystemAccounts(tx, companyId, codes);
          const accountId = new Map<string, number>();
          for (const status of statuses) {
            if (status.state === "missing" || status.state === "deleted") {
              throw new Error("A required system account is not available");
            }
            accountId.set(status.code, status.accountId);
          }
          const { voucher } = await insertInfrastructureVoucherTx(
            tx,
            {
              companyId,
              voucherNumber: `GL-INVENTORY-OPENING-${companyId}`,
              voucherType: "Journal",
              voucherDate: plan.journalDate,
              description: ["Opening inventory at the perpetual-inventory cut-over", effectiveFrom].join(" "),
              totalAmount: openingDebitTotal(plan).toFixed(2),
              currency: "USD",
              exchangeRate: "1",
            },
            infrastructurePostingIdentity("perpetual-inventory-opening", companyId)
          );
          id = voucher.id;
          // A line whose ledger balance exceeds its target credits the account.
          const sides = (amount: string) => {
            const value = toMoney(amount);
            return value.isNegative()
              ? { debitAmount: "0.00", creditAmount: value.negated().toFixed(2) }
              : { debitAmount: value.toFixed(2), creditAmount: "0.00" };
          };
          const equity = toMoney(plan.total).negated().toFixed(2);
          await tx.insert(voucherEntries).values([
            ...plan.lines.map((line) => ({
              voucherId: id!,
              ledgerAccountId: accountId.get(line.accountCode)!,
              ...sides(line.amount),
              narration: line.basis,
            })),
            ...(toMoney(equity).isZero()
              ? []
              : [
                  {
                    voucherId: id,
                    ledgerAccountId: accountId.get("OPENING_BALANCE_EQUITY")!,
                    ...sides(equity),
                    narration: "Stock on hand capitalised at the cut-over",
                  },
                ]),
          ]);
        }
        await tx.execute(sql`
      INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_voucher_id, opening_plan, applied_by)
      VALUES (${companyId}, ${effectiveFrom}, ${id}, ${JSON.stringify(plan)}::jsonb, ${appliedBy})
    `);
        return { plan, voucherId: id };
      },
      { isolationLevel: "repeatable read" }
    )
    .catch((error: unknown) => {
      const failure = error as { code?: string; cause?: { code?: string } } | null;
      if (failure?.code === "23505" || failure?.cause?.code === "23505") {
        throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
      }
      throw error;
    });
  return applied;
}
