import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../../db";
import { toMoney } from "../../../lib/money";
import { planReadinessResolutionTx } from "../../inventory/inventoryReadinessResolution";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "../infrastructureVoucherIdentity";
import { ensureSystemAccounts } from "../systemAccounts";
import { factoryCutoverBlockerMessage, factoryCutoverBlockers } from "./factoryCutoverBlockers";
import { PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";
import {
  ISO_DATE,
  OpeningJournalRefusal,
  openingDebitTotal,
  planOpeningInventoryJournal,
  rows,
  type OpeningInventoryPlan,
} from "./planOpeningInventoryJournal";
export {
  OpeningJournalRefusal,
  factoryGoodsInTransitAtEve,
  planOpeningInventoryJournal,
} from "./planOpeningInventoryJournal";
export type { OpeningInventoryPlan, OpeningJournalLine } from "./planOpeningInventoryJournal";

export type { UnvaluedRow } from "./factoryValuation";

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
  options: {
    postingReady?: boolean;
    today?: string;
    // Phase 21 (B): the caller's cut-over audit, written on this transaction.
    auditTx?: (tx: DbTransaction, applied: { plan: OpeningInventoryPlan; voucherId: number | null }) => Promise<void>;
  } = {}
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
        if (options.auditTx) await options.auditTx(tx, { plan, voucherId: id });
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
