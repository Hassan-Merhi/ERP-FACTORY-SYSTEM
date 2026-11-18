// Extracted from ./costing.ts: purchase voucher resync for the costing repair.
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { vouchers, voucherEntries, purchaseOrders } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import {
  differsByMoreThanTolerance as differs,
  isCreditOnlyEntry as isCreditOnly,
  isDebitOnlyEntry as isDebitOnly,
} from "../containerHelpers";
import { moneyString, sumMoney, toMoney } from "../../../lib/money";
import { usdLineAmounts } from "../../../services/factory/factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../../../services/factory/factoryVoucherCorrection";
import type { calcPoAmountsExact } from "../containerHelpers";
import type Decimal from "decimal.js";
import type { Request } from "express";

export async function resyncPoVoucherCosting({
  po,
  hasParentFreight,
  isSameCompanyPo,
  poFreightParentAccountId,
  poFreight,
  grossTotal,
  hasOwnFreight,
  freightAccountId,
  expectedLocalTotal,
  req,
  intercoTotal,
  cNum,
  poCounts,
}: {
  po: typeof purchaseOrders.$inferSelect;
  hasParentFreight: boolean;
  isSameCompanyPo: boolean;
  poFreightParentAccountId: number | null;
  poFreight: ReturnType<typeof toMoney>;
  grossTotal: ReturnType<typeof calcPoAmountsExact>["grossTotal"];
  hasOwnFreight: boolean;
  freightAccountId: number | null;
  expectedLocalTotal: Decimal;
  req: Request;
  intercoTotal: ReturnType<typeof calcPoAmountsExact>["intercoTotal"];
  cNum: string;
  poCounts: {
    scannedPOs: number;
    updatedLocalVouchers: number;
    updatedParentVouchers: number;
    updatedFreightVouchers: number;
  };
}) {
  if (po.voucherId) {
    const [localVoucher] = await db
      .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
      .from(vouchers)
      .where(eq(vouchers.id, po.voucherId))
      .limit(1);

    if (localVoucher) {
      const currentLocalTotal = toMoney(localVoucher.totalAmount);
      const entries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, po.voucherId));

      // ── Determine if a repair is needed ──────────────────────────
      let freightEntryMissing = false;
      if (hasParentFreight) {
        if (isSameCompanyPo) {
          // Same-company: freight CR entry must exist at freightParentAccountId
          const freightCrEntry = entries.find(
            (e) => Number(e.ledgerAccountId) === poFreightParentAccountId && isCreditOnly(e)
          );
          freightEntryMissing = !freightCrEntry || differs(toMoney(freightCrEntry.creditAmount), poFreight);
        } else {
          // Interco: detect old single-DR structure or wrong DR sum → needs rebuild
          const drEntries = entries.filter((e) => isDebitOnly(e));
          const drSum = sumMoney(drEntries.map((e) => e.debitAmount));
          const strayFreightCr = poFreightParentAccountId
            ? entries.some(
                (e) => Number(e.ledgerAccountId) === poFreightParentAccountId && toMoney(e.creditAmount).gt(0)
              )
            : false;
          freightEntryMissing = drEntries.length !== 2 || differs(drSum, grossTotal) || strayFreightCr;
        }
      } else if (hasOwnFreight) {
        // Own-freight: freight CR to freightAccountId must exist in child's voucher
        const freightCrEntry = entries.find(
          (e) => e.ledgerAccountId === freightAccountId && toMoney(e.creditAmount).gt(0)
        );
        freightEntryMissing = !freightCrEntry;
      }
      const localMismatch = differs(currentLocalTotal, expectedLocalTotal) || freightEntryMissing;

      if (localMismatch) {
        logger.info(
          `[SyncAll] PO ${po.poNumber}: local voucher #${po.voucherId} ${currentLocalTotal.toString()} → ${expectedLocalTotal.toString()}`
        );
        const poVoucherId = po.voucherId;
        // Phase 22 (C), G4/PE9: an audited in-place edit of the posted
        // purchase voucher; a voucher in a closed period is refused (409:
        // reverse and re-post) and reported for this PO in `errors`.
        await db.transaction((tx) =>
          editPostedFactoryVoucherTx(
            tx,
            {
              companyId: po.companyId,
              voucherIds: [poVoucherId],
              reason: "containers-sync-all-vouchers",
              actor: { userId: req.session.userId, username: req.session.username },
            },
            async () => {
              await tx
                .update(vouchers)
                .set({ totalAmount: moneyString(expectedLocalTotal) })
                .where(eq(vouchers.id, poVoucherId));

              if (hasParentFreight) {
                if (isSameCompanyPo) {
                  // Same-company: embed freight into the PO voucher.
                  // User pays freight themselves — freight account is a payable (CR).
                  //   DR Purchases (grossTotal — goods + freight)
                  //   CR (supplier/payable entry) (intercoTotal — goods only)
                  //   CR freightParentAccountId (freight)
                  let purchasesEntryId: number | null = null;
                  let mainCrEntryId: number | null = null;
                  const toDeleteIds: number[] = [];
                  const freightCrCandidates3: number[] = [];
                  for (const entry of entries) {
                    const acctId = entry.ledgerAccountId as number | null;
                    const isDebit = isDebitOnly(entry);
                    const isCredit = isCreditOnly(entry);
                    if (isCredit && acctId === poFreightParentAccountId) {
                      freightCrCandidates3.push(entry.id);
                    } else if (isDebit && purchasesEntryId === null) {
                      purchasesEntryId = entry.id;
                    } else if (isCredit && mainCrEntryId === null) {
                      mainCrEntryId = entry.id;
                    } else {
                      toDeleteIds.push(entry.id);
                    }
                  }
                  const freightCrEntryId = freightCrCandidates3[0] ?? null;
                  toDeleteIds.push(...freightCrCandidates3.slice(1));
                  if (toDeleteIds.length > 0)
                    await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
                  if (purchasesEntryId !== null)
                    await tx
                      .update(voucherEntries)
                      .set(usdLineAmounts(moneyString(grossTotal), 0))
                      .where(eq(voucherEntries.id, purchasesEntryId));
                  if (mainCrEntryId !== null)
                    await tx
                      .update(voucherEntries)
                      .set(usdLineAmounts(0, moneyString(intercoTotal)))
                      .where(eq(voucherEntries.id, mainCrEntryId));
                  const _syncAllFreightNarration = `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`;
                  if (freightCrEntryId !== null) {
                    await tx
                      .update(voucherEntries)
                      .set({
                        ...usdLineAmounts(0, moneyString(poFreight)),
                        ledgerAccountId: poFreightParentAccountId!,
                        narration: _syncAllFreightNarration,
                      })
                      .where(eq(voucherEntries.id, freightCrEntryId));
                  } else {
                    await tx.insert(voucherEntries).values({
                      voucherId: poVoucherId,
                      ledgerAccountId: poFreightParentAccountId!,
                      ...usdLineAmounts(0, moneyString(poFreight)),
                      narration: _syncAllFreightNarration,
                    });
                  }
                  poCounts.updatedFreightVouchers++;
                } else {
                  // Interco: delete-and-rebuild approach.
                  //   DR Purchases (intercoTotal — goods)
                  //   DR Purchases (freight — same account)
                  //   CR parentCreditAccount (grossTotal)
                  const childSettings = await storage.getCompanySettings(po.companyId);
                  const parentCreditAcctId = childSettings?.parentCreditAccountId ?? null;

                  let parentCreditEntryId: number | null = null;
                  let purchasesAcctId: number | null = null;
                  const toDeleteIds: number[] = [];

                  for (const entry of entries) {
                    const acctId = entry.ledgerAccountId as number | null;
                    const isDebit = isDebitOnly(entry);
                    const isCredit = isCreditOnly(entry);

                    if (isCredit && acctId === parentCreditAcctId && parentCreditEntryId === null) {
                      parentCreditEntryId = entry.id;
                    } else {
                      toDeleteIds.push(entry.id);
                      if (isDebit && acctId !== poFreightParentAccountId && !purchasesAcctId) {
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
                      .set(usdLineAmounts(0, moneyString(grossTotal)))
                      .where(eq(voucherEntries.id, parentCreditEntryId));
                  } else if (parentCreditAcctId) {
                    await tx.insert(voucherEntries).values({
                      voucherId: poVoucherId,
                      ledgerAccountId: parentCreditAcctId,
                      ...usdLineAmounts(0, moneyString(grossTotal)),
                      narration: `PO ${po.poNumber} - Credit to parent`,
                    });
                  }

                  if (purchasesAcctId) {
                    await tx.insert(voucherEntries).values([
                      {
                        voucherId: poVoucherId,
                        ledgerAccountId: purchasesAcctId,
                        ...usdLineAmounts(moneyString(intercoTotal), 0),
                        narration: `${po.poNumber}`,
                      },
                      {
                        voucherId: poVoucherId,
                        ledgerAccountId: purchasesAcctId,
                        ...usdLineAmounts(moneyString(poFreight), 0),
                        narration: `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`,
                      },
                    ]);
                  }
                } // end interco branch
              } else if (hasOwnFreight) {
                // Own-freight: DR Purchases (goods) + DR FreightOwnAccount (freight)
                //              CR Supplier (goods) + CR FreightOwnAccount (freight)
                let purchasesAcctId: number | null = null;
                let freightCrFound = false;
                for (const entry of entries) {
                  const isDebit = isDebitOnly(entry);
                  const isCredit = isCreditOnly(entry);
                  if (isDebit) {
                    if (!purchasesAcctId) purchasesAcctId = entry.ledgerAccountId ?? null;
                    if (entry.ledgerAccountId !== freightAccountId) {
                      await tx
                        .update(voucherEntries)
                        .set(usdLineAmounts(moneyString(intercoTotal), 0))
                        .where(eq(voucherEntries.id, entry.id));
                    }
                  } else if (isCredit) {
                    if (entry.ledgerAccountId === freightAccountId) {
                      freightCrFound = true;
                      await tx
                        .update(voucherEntries)
                        .set(usdLineAmounts(0, moneyString(poFreight)))
                        .where(eq(voucherEntries.id, entry.id));
                    } else {
                      await tx
                        .update(voucherEntries)
                        .set(usdLineAmounts(0, moneyString(intercoTotal)))
                        .where(eq(voucherEntries.id, entry.id));
                    }
                  }
                }
                if (!freightCrFound && purchasesAcctId) {
                  await tx.insert(voucherEntries).values([
                    {
                      voucherId: poVoucherId,
                      ledgerAccountId: purchasesAcctId,
                      ...usdLineAmounts(moneyString(poFreight), 0),
                      narration: `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`,
                    },
                    {
                      voucherId: poVoucherId,
                      ledgerAccountId: freightAccountId,
                      ...usdLineAmounts(0, moneyString(poFreight)),
                      narration: `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`,
                    },
                  ]);
                }
              } else {
                // Standard supplier-paid freight: all entries → expectedLocalTotal
                for (const entry of entries) {
                  const isDebit = isDebitOnly(entry) ? true : isCreditOnly(entry) ? false : !entry.supplierId;
                  if (isDebit) {
                    await tx
                      .update(voucherEntries)
                      .set(usdLineAmounts(moneyString(expectedLocalTotal), 0))
                      .where(eq(voucherEntries.id, entry.id));
                  } else {
                    await tx
                      .update(voucherEntries)
                      .set(usdLineAmounts(0, moneyString(expectedLocalTotal)))
                      .where(eq(voucherEntries.id, entry.id));
                  }
                }
              }
            }
          )
        );
        poCounts.updatedLocalVouchers++;
      }
    }
  }
}
