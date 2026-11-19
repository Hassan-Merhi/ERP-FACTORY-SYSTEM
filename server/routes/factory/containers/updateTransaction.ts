// Extracted from ./update.ts: the container update and its voucher re-sync inside one transaction.
import { getClientDate } from "../../../lib/dateUtils";
import { resolveStoredFxRateOrThrow } from "../../../services/factory/currencyConversion";
import { factoryContainers, voucherEntries, vouchers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";
import { postFactoryVoucherTx, type FactoryVoucherLine } from "../../../services/factory/factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../../../services/factory/factoryVoucherCorrection";
import { containerFreightFxRateToUsd } from "../../../services/factory/factoryVoucherEntryAmounts";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import type { Request } from "express";
import type { prepareFactoryContainerUpdate } from "./updateInput";
import type { planFactoryContainerUpdateSync } from "./updateSyncPlan";
import type { DbTransaction } from "../../../db";

type PlanFactoryContainerUpdateSyncResult = Awaited<ReturnType<typeof planFactoryContainerUpdateSync>>;
type PrepareFactoryContainerUpdateResult = Awaited<ReturnType<typeof prepareFactoryContainerUpdate>>;

export async function applyFactoryContainerUpdateTx({
  tx,
  input,
  plan,
  req,
}: {
  tx: DbTransaction;
  input: Extract<PrepareFactoryContainerUpdateResult, { done: false }>;
  plan: Extract<PlanFactoryContainerUpdateSyncResult, { done: false }>;
  req: Request;
}) {
  const {
    goodsNeedsSync,
    existingImports,
    firstGoodsCostAccountId,
    previousGoodsValue,
    existingFV,
    freightNeedsSync,
    commissionNeedsSync,
  } = plan;
  const { updateData, id, companyId } = input;
  const [updated] = await tx
    .update(factoryContainers)
    .set(updateData)
    .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)))
    .returning();
  if (!updated) return null;

  if (goodsNeedsSync) {
    const goodsValue = toMoney(updated.totalKg).times(toMoney(updated.ratePerKg));
    if (goodsValue.lessThanOrEqualTo(0) || !updated.supplierId) {
      if (existingImports.length > 0) {
        throw new Error(
          "A posted goods-import journal cannot lose its purchase supplier or goods amount. Use an audited reversal."
        );
      }
    } else {
      const goodsCcy = updated.currencyCode || "USD";
      const goodsFx = resolveStoredFxRateOrThrow(goodsCcy, updated.fxRateToUsd, updated.fxRateConfirmed);
      const importVoucher = existingImports[0];
      if (importVoucher) {
        const importEntries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, importVoucher.id));
        const debitLines = importEntries.filter((line) => toMoney(line.debitAmount).greaterThan(0));
        const creditLines = importEntries.filter((line) => toMoney(line.creditAmount).greaterThan(0));
        if (
          importEntries.length !== 2 ||
          debitLines.length !== 1 ||
          creditLines.length !== 1 ||
          !debitLines[0].ledgerAccountId ||
          !creditLines[0].factorySupplierId
        ) {
          throw new Error("Import journal has an unexpected entry shape. Review its postings before editing.");
        }
        // A non-USD legacy voucher lacks the historical native/base record.
        // Do not rewrite such history with today's or the container's
        // currently displayed rate; it requires the reviewed FX repair.
        if (
          goodsCcy !== "USD" &&
          importEntries.some(
            (line) => !line.transactionCurrency || line.baseDebitAmount == null || line.baseCreditAmount == null
          )
        ) {
          throw new Error(
            "This import journal has unconverted historical FX entries. Review and repair its original rate before changing the goods posting."
          );
        }
        const normalizedDr = normFactoryEntry(goodsCcy, goodsValue.toFixed(), "0", goodsFx);
        const normalizedCr = normFactoryEntry(goodsCcy, "0", goodsValue.toFixed(), goodsFx);
        await editPostedFactoryVoucherTx(
          tx,
          {
            companyId: companyId,
            voucherIds: [importVoucher.id],
            reason: "factory-container-goods-resync",
            actor: { userId: req.session.userId, username: req.session.username },
          },
          async () => {
            await tx
              .update(vouchers)
              .set({
                totalAmount: goodsValue.toFixed(2),
                currency: goodsCcy,
                exchangeRate: String(goodsFx),
              })
              .where(eq(vouchers.id, importVoucher.id));
            await tx.update(voucherEntries).set(normalizedDr).where(eq(voucherEntries.id, debitLines[0].id));
            await tx
              .update(voucherEntries)
              .set({
                ...normalizedCr,
                // The import (goods) payable belongs to the goods supplier;
                // only the freight journal credits the freight payee.
                factorySupplierId: updated.supplierId,
                ledgerAccountId: null,
              })
              .where(eq(voucherEntries.id, creditLines[0].id));
          }
        );
      } else if (firstGoodsCostAccountId && previousGoodsValue.isZero()) {
        // An explicit first-time goods entry on a previously zero-value
        // container: Dr import cost / Cr the selected goods supplier.
        // Post on the edit date rather than silently backdating a liability.
        await postFactoryVoucherTx(tx, {
          companyId: companyId,
          voucherNumber: (generation) => `FACTORY-IMPORT-${id}-${generation}`,
          voucherDate: getClientDate(req),
          description: `Goods import - container ${updated.containerNumber}`,
          currency: goodsCcy,
          fxRateToUsd: String(goodsFx),
          source: { sourceType: "factory-container-import", sourceId: id, phase: "goods" },
          lines: [
            {
              ledgerAccountId: firstGoodsCostAccountId,
              debit: goodsValue,
              narration: `Goods import cost - container ${updated.containerNumber}`,
            },
            {
              factorySupplierId: updated.supplierId,
              credit: goodsValue,
              narration: `Goods payable to supplier - container ${updated.containerNumber}`,
            },
          ],
        });
      } else {
        // Legacy positive-value (or previously reversed) imports still
        // require explicit review; an edit must never re-create history.
        throw new Error(
          "This container has no goods-import journal. Review it in the import-credit backfill preview and post the missing journal explicitly before editing its goods or supplier."
        );
      }
    }
  }

  const newFreightAmt = toMoney(updated.freight);
  const newFreightAcctId = updated.freightAccountId ?? null;
  const newFreightPaidBy = updated.freightPaidBy || "supplier";
  const newFreightOwnAcctId = updated.freightOwnAccountId ?? null;
  const freightCcy = updated.freightCurrencyCode || updated.currencyCode || "USD";

  if (newFreightAmt.greaterThan(0) && newFreightAcctId) {
    if (existingFV) {
      const editActor = { userId: req.session.userId, username: req.session.username };
      if (freightNeedsSync) {
        // Full re-sync: update voucher amount/type and re-compute entries with FX.
        // Phase 22 (C), G4: an in-place edit of a posted voucher — refused in a
        // closed period (409, correct by reversal), audited before/after otherwise.
        const updateFreightFactoryFxRate = containerFreightFxRateToUsd(updated);
        const normFreightDr = normFactoryEntry(freightCcy, newFreightAmt.toFixed(), "0", updateFreightFactoryFxRate);
        const normFreightCr = normFactoryEntry(freightCcy, "0", newFreightAmt.toFixed(), updateFreightFactoryFxRate);
        await editPostedFactoryVoucherTx(
          tx,
          {
            companyId: companyId,
            voucherIds: [existingFV.id],
            reason: "factory-container-freight-resync",
            actor: editActor,
          },
          async () => {
            await tx
              .update(vouchers)
              .set({
                totalAmount: newFreightAmt.toFixed(),
                currency: freightCcy,
                exchangeRate: String(updateFreightFactoryFxRate),
                voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
              })
              .where(eq(vouchers.id, existingFV.id));
            const fEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, existingFV.id));
            for (const fe of fEntries) {
              if (toMoney(fe.debitAmount).greaterThan(0)) {
                // Dr Freight Expense — update amount and account
                await tx
                  .update(voucherEntries)
                  .set({ ledgerAccountId: newFreightAcctId, ...normFreightDr })
                  .where(eq(voucherEntries.id, fe.id));
              } else if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
                // Cr Own account
                await tx
                  .update(voucherEntries)
                  .set({
                    ledgerAccountId: newFreightOwnAcctId,
                    factorySupplierId: null,
                    ...normFreightCr,
                  })
                  .where(eq(voucherEntries.id, fe.id));
              } else if (newFreightPaidBy === "supplier" && updated.freightSupplierId) {
                // Cr Supplier
                await tx
                  .update(voucherEntries)
                  .set({
                    factorySupplierId: updated.freightSupplierId,
                    ledgerAccountId: null,
                    ...normFreightCr,
                  })
                  .where(eq(voucherEntries.id, fe.id));
              }
            }
          }
        );
      } else if (updateData.arrivalDate) {
        // Date-only PATCH: keep existing entries as-is, just update the voucher date
        // so the freight voucher stays in sync with the new ETA (audited edit).
        const arrivalDate = updateData.arrivalDate;
        await editPostedFactoryVoucherTx(
          tx,
          {
            companyId: companyId,
            voucherIds: [existingFV.id],
            reason: "factory-container-freight-date",
            actor: editActor,
            newVoucherDate: arrivalDate,
          },
          () => tx.update(vouchers).set({ voucherDate: arrivalDate }).where(eq(vouchers.id, existingFV.id))
        );
      }
      // else: nothing freight-related changed and no date → no-op
    } else if (freightNeedsSync) {
      // Create new freight voucher — only when freight fields were explicitly set.
      // A date-only PATCH should never create a freight voucher from scratch.
      // Use arrivalDate if set, else fall back to the container's own createdAt
      // (NOT today) so an edit made months later doesn't stamp a new voucher
      // with the current date. Phase 22 (C): through the engine, same posting
      // identity as the create route's freight journal.
      const today = getClientDate(req);
      const containerCreatedDate = updated.createdAt ? new Date(updated.createdAt).toISOString().slice(0, 10) : today;
      const lines: FactoryVoucherLine[] = [
        {
          ledgerAccountId: newFreightAcctId,
          debit: newFreightAmt,
          narration: `Freight expense - container ${updated.containerNumber}`,
        },
      ];
      if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
        lines.push({
          ledgerAccountId: newFreightOwnAcctId,
          credit: newFreightAmt,
          narration: `Freight paid via own account - container ${updated.containerNumber}`,
        });
      } else if (newFreightPaidBy === "supplier" && updated.freightSupplierId) {
        lines.push({
          factorySupplierId: updated.freightSupplierId,
          credit: newFreightAmt,
          narration: `Freight payable to supplier - container ${updated.containerNumber}`,
        });
      }
      await postFactoryVoucherTx(tx, {
        companyId: companyId,
        voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
        voucherNumber: `FACTORY-FREIGHT-${id}`,
        voucherDate: updated.arrivalDate || containerCreatedDate,
        description: `Freight on container ${updated.containerNumber}`,
        currency: freightCcy,
        fxRateToUsd: String(containerFreightFxRateToUsd(updated)),
        source: { sourceType: "factory-container-freight", sourceId: id, phase: "freight" },
        lines,
      });
    }
  } else if (existingFV && freightNeedsSync) {
    // Freight amount dropped to zero AND freight fields were explicitly changed →
    // delete the now-empty freight voucher.
    // (A date-only PATCH must never delete an existing freight voucher.)
    // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
    await retireVouchersTx(tx, {
      companyId: companyId,
      voucherIds: [existingFV.id],
      reason: "factory-container-freight-resync",
      actor: sessionRetirementActor(req),
    });
  }

  if (commissionNeedsSync) await syncContainerCommissionJournalTx(tx, companyId, id);
  return updated;
}
