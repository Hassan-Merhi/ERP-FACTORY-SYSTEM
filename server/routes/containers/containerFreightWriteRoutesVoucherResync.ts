// Extracted from ./containerFreightWriteRoutes.ts: purchase voucher resync stage.
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import {
  differsByMoreThanTolerance as differs,
  isCreditOnlyEntry as isCreditOnly,
  isDebitOnlyEntry as isDebitOnly,
} from "./containerHelpers";
import { moneyString, toMoney } from "../../lib/money";
import { usdLineAmounts } from "../../services/factory/factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../../services/factory/factoryVoucherCorrection";
import type { containerFreightWriteRoutesStep } from "./containerFreightWriteRoutesStep";
import type { containerFreightWriteRoutesStep2 } from "./containerFreightWriteRoutesStep2";
import type { Request } from "express";
import type { DbTransaction } from "../../db";

type ContainerFreightWriteRoutesStepResult = Awaited<ReturnType<typeof containerFreightWriteRoutesStep>>;
type ContainerFreightWriteRoutesStep2Result = Awaited<ReturnType<typeof containerFreightWriteRoutesStep2>>;

export async function resyncPurchaseOrderVoucher({
  existingPO,
  voucherTotalMismatch,
  newLocalVoucherTotal,
  oldLocalVoucherTotal,
  freightPaidByChanged,
  freightOwnAccountChanged,
  freightParentVoucherNeedsUpdate,
  tx,
  req,
  newHasParentFreight,
  newFreightParentAccountId,
  _pfParentId,
  _isSameCompanyOrNoInterco,
  newFreight,
  newGrandTotal,
  supplierTotal,
  _freightNarration,
  newHasOwnFreight,
  newFreightOwnAccountId,
}: {
  existingPO: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["existingPO"];
  voucherTotalMismatch: ContainerFreightWriteRoutesStep2Result["voucherTotalMismatch"];
  newLocalVoucherTotal: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newLocalVoucherTotal"];
  oldLocalVoucherTotal: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["oldLocalVoucherTotal"];
  freightPaidByChanged: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["freightPaidByChanged"];
  freightOwnAccountChanged: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["freightOwnAccountChanged"];
  freightParentVoucherNeedsUpdate: Extract<
    ContainerFreightWriteRoutesStepResult,
    { done: false }
  >["freightParentVoucherNeedsUpdate"];
  tx: DbTransaction;
  req: Request;
  newHasParentFreight: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newHasParentFreight"];
  newFreightParentAccountId: Extract<
    ContainerFreightWriteRoutesStepResult,
    { done: false }
  >["newFreightParentAccountId"];
  _pfParentId: ContainerFreightWriteRoutesStep2Result["_pfParentId"];
  _isSameCompanyOrNoInterco: ContainerFreightWriteRoutesStep2Result["_isSameCompanyOrNoInterco"];
  newFreight: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newFreight"];
  newGrandTotal: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newGrandTotal"];
  supplierTotal: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["supplierTotal"];
  _freightNarration: ContainerFreightWriteRoutesStep2Result["_freightNarration"];
  newHasOwnFreight: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newHasOwnFreight"];
  newFreightOwnAccountId: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>["newFreightOwnAccountId"];
}) {
  // Update the purchase voucher linked to the PO
  if (
    existingPO.voucherId &&
    (voucherTotalMismatch ||
      differs(newLocalVoucherTotal, oldLocalVoucherTotal) ||
      freightPaidByChanged ||
      freightOwnAccountChanged ||
      freightParentVoucherNeedsUpdate)
  ) {
    const poVoucherId = existingPO.voucherId;
    // Phase 22 (C), G4/PE9: an in-place edit of the posted purchase
    // voucher — refused (409, reverse and re-post) in a closed period,
    // audited before/after in this transaction otherwise. Every amount
    // column of a changed line is written (usdLineAmounts).
    await editPostedFactoryVoucherTx(
      tx,
      {
        companyId: existingPO.companyId,
        voucherIds: [poVoucherId],
        reason: "purchase-order-voucher-resync",
        actor: { userId: req.session.userId, username: req.session.username },
      },
      async () => {
        // Update voucher total amount
        await tx
          .update(vouchers)
          .set({ totalAmount: moneyString(newLocalVoucherTotal) })
          .where(eq(vouchers.id, poVoucherId));

        const existingEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, poVoucherId));

        if (newHasParentFreight && newFreightParentAccountId) {
          logger.info(
            `[PO-PATCH charges] Freight posting: PO=${existingPO.poNumber} company=${existingPO.companyId} freightAcct=${newFreightParentAccountId} parentCoId=${_pfParentId} sameCompany=${_isSameCompanyOrNoInterco} freightAmt=${newFreight}`
          );

          if (_isSameCompanyOrNoInterco) {
            // ── Same-company parent freight ──────────────────────────────────────
            // The PO is on the parent company itself (or there is no interco config).
            // The user pays freight themselves (not via the supplier), so freight is
            // credited to the freight account (a payable) and the supplier is only
            // credited for the goods amount.
            // Structure:
            //   DR Purchases (newGrandTotal — full cost incl. freight)
            //   CR (supplier/payable entry) (supplierTotal — goods only)
            //   CR freightParentAccountId (newFreight — freight payable)
            //
            // Strategy: keep first DR (purchases), keep first non-freight CR (supplier),
            // keep/create freight CR at freightParentAccountId, delete extras.
            let purchasesEntryId: number | null = null;
            let mainCrEntryId: number | null = null;
            const toDeleteIds: number[] = [];
            const freightCrCandidatesPatch: number[] = [];

            for (const entry of existingEntries) {
              const acctId = entry.ledgerAccountId as number | null;
              const isDebit = isDebitOnly(entry);
              const isCredit = isCreditOnly(entry);

              if (isCredit && acctId === newFreightParentAccountId) {
                freightCrCandidatesPatch.push(entry.id);
              } else if (isDebit && purchasesEntryId === null) {
                purchasesEntryId = entry.id; // first DR = purchases
              } else if (isCredit && mainCrEntryId === null) {
                mainCrEntryId = entry.id; // first non-freight CR = supplier payable
              } else {
                toDeleteIds.push(entry.id); // extras — delete
              }
            }
            const freightCrEntryId: number | null = freightCrCandidatesPatch[0] ?? null;
            toDeleteIds.push(...freightCrCandidatesPatch.slice(1));

            if (toDeleteIds.length > 0) {
              await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
            }

            // Update purchases DR to full gross amount (goods + freight)
            if (purchasesEntryId !== null) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(moneyString(newGrandTotal), 0))
                .where(eq(voucherEntries.id, purchasesEntryId));
            }

            // Update main CR to goods-only amount (supplier payable)
            if (mainCrEntryId !== null) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(0, moneyString(supplierTotal)))
                .where(eq(voucherEntries.id, mainCrEntryId));
            }

            // Update or insert freight CR entry pointing at freightParentAccountId
            if (freightCrEntryId !== null) {
              await tx
                .update(voucherEntries)
                .set({
                  ...usdLineAmounts(0, moneyString(newFreight)),
                  ledgerAccountId: newFreightParentAccountId,
                  narration: _freightNarration,
                })
                .where(eq(voucherEntries.id, freightCrEntryId));
            } else {
              await tx.insert(voucherEntries).values({
                voucherId: poVoucherId,
                ledgerAccountId: newFreightParentAccountId,
                ...usdLineAmounts(0, moneyString(newFreight)),
                narration: _freightNarration,
              });
            }
          } else {
            // ── Interco parent freight (subsidiary → parent company) ────────────
            // Child's voucher never references freightParentAccountId directly.
            // Structure:
            //   DR Purchases (supplierTotal — goods)
            //   DR Purchases (newFreight — freight, same purchases account)
            //   CR parentCreditAccountId (newGrandTotal — full intercompany payable)
            //
            // Strategy: keep the parentCredit CR, delete everything else, rebuild DRs.
            const childSettings = await storage.getCompanySettings(existingPO.companyId);
            const parentCreditAcctId = childSettings?.parentCreditAccountId ?? null;

            let parentCreditEntryId: number | null = null;
            let purchasesAcctId: number | null = null;
            const toDeleteIds: number[] = [];

            for (const entry of existingEntries) {
              const acctId = entry.ledgerAccountId as number | null;
              const isDebit = isDebitOnly(entry);
              const isCredit = isCreditOnly(entry);

              if (isCredit && acctId === parentCreditAcctId && parentCreditEntryId === null) {
                parentCreditEntryId = entry.id;
              } else {
                toDeleteIds.push(entry.id);
                if (isDebit && acctId !== newFreightParentAccountId && !purchasesAcctId) {
                  purchasesAcctId = acctId;
                }
              }
            }

            if (toDeleteIds.length > 0) {
              await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
            }

            if (parentCreditEntryId !== null) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(0, moneyString(newGrandTotal)))
                .where(eq(voucherEntries.id, parentCreditEntryId));
            } else if (parentCreditAcctId) {
              await tx.insert(voucherEntries).values({
                voucherId: poVoucherId,
                ledgerAccountId: parentCreditAcctId,
                ...usdLineAmounts(0, moneyString(newGrandTotal)),
                narration: `PO ${existingPO.poNumber} - Credit to parent`,
              });
            }

            if (purchasesAcctId) {
              await tx.insert(voucherEntries).values([
                {
                  voucherId: poVoucherId,
                  ledgerAccountId: purchasesAcctId,
                  ...usdLineAmounts(moneyString(supplierTotal), 0),
                  narration: `${existingPO.poNumber}`,
                },
                {
                  voucherId: poVoucherId,
                  ledgerAccountId: purchasesAcctId,
                  ...usdLineAmounts(moneyString(newFreight), 0),
                  narration: _freightNarration,
                },
              ]);
            }
          }
        } else if (newHasOwnFreight && newFreightOwnAccountId) {
          // Own-paid freight: split inside purchase voucher
          //   DR Purchases (supplierTotal) + DR FreightOwn (newFreight)
          //   CR Supplier (supplierTotal)  + CR FreightOwn (newFreight)
          let purchasesAcctId: number | null = null;
          let freightCrFound = false;
          for (const entry of existingEntries) {
            const isDebit = isDebitOnly(entry);
            const isCredit = isCreditOnly(entry);
            if (isDebit) {
              if (!purchasesAcctId) purchasesAcctId = entry.ledgerAccountId ?? null;
              if (entry.ledgerAccountId !== newFreightOwnAccountId) {
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(moneyString(supplierTotal), 0))
                  .where(eq(voucherEntries.id, entry.id));
              } else {
                // Existing freight DR entry — keep/update
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(moneyString(newFreight), 0))
                  .where(eq(voucherEntries.id, entry.id));
              }
            } else if (isCredit) {
              if (entry.ledgerAccountId === newFreightOwnAccountId) {
                freightCrFound = true;
                await tx
                  .update(voucherEntries)
                  .set({
                    ...usdLineAmounts(0, moneyString(newFreight)),
                    ledgerAccountId: newFreightOwnAccountId,
                  })
                  .where(eq(voucherEntries.id, entry.id));
              } else {
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(0, moneyString(supplierTotal)))
                  .where(eq(voucherEntries.id, entry.id));
              }
            }
          }
          if (!freightCrFound && purchasesAcctId) {
            await tx.insert(voucherEntries).values([
              {
                voucherId: poVoucherId,
                ledgerAccountId: purchasesAcctId,
                ...usdLineAmounts(moneyString(newFreight), 0),
                narration: _freightNarration,
              },
              {
                voucherId: poVoucherId,
                ledgerAccountId: newFreightOwnAccountId,
                ...usdLineAmounts(0, moneyString(newFreight)),
                narration: _freightNarration,
              },
            ]);
          }
        } else {
          // Standard: all entries to newLocalVoucherTotal (no embedded freight)
          // If switching away from embedded freight, remove freight entries first
          const freightEntryIds = existingEntries
            .filter((e) => {
              const acct = e.ledgerAccountId;
              return (
                acct === (existingPO.freightOwnAccountId ?? -1) || acct === (existingPO.freightParentAccountId ?? -1)
              );
            })
            .map((e) => e.id);
          if (freightEntryIds.length > 0) {
            await tx.delete(voucherEntries).where(inArray(voucherEntries.id, freightEntryIds));
          }
          // Also remove the matching freight DR entries (identified by narration)
          const remainingEntries = existingEntries.filter((e) => !freightEntryIds.includes(e.id));
          for (const entry of remainingEntries) {
            if (toMoney(entry.debitAmount).gt(0)) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(moneyString(newLocalVoucherTotal), 0))
                .where(eq(voucherEntries.id, entry.id));
            } else if (toMoney(entry.creditAmount).gt(0)) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(0, moneyString(newLocalVoucherTotal)))
                .where(eq(voucherEntries.id, entry.id));
            }
          }
        }
      }
    );
  }
}
