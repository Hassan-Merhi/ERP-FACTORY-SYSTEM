/**
 * containerAccountingRoutes: ContainerCosting endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../../auth";
import {
  containers,
  containerCharges,
  purchaseOrders,
  vouchers,
  voucherEntries,
  intercompanyPosConfigs,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  calcPoAmountsExact,
  differsByMoreThanTolerance as differs,
  isCreditOnlyEntry as isCreditOnly,
  isDebitOnlyEntry as isDebitOnly,
  syncIntercoParentVoucher,
} from "../containerHelpers";
import { moneyString, sumMoney, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

const CHARGE_FIELDS = ["freight", "surcharge", "fumigation", "documentCharges", "discount", "otherCharges"] as const;
type ChargeField = (typeof CHARGE_FIELDS)[number];

export function registerContainerCostingRoutes(app: Express) {
  app.post(
    "/api/containers/sync-all-vouchers",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const parentCompanyId = await storage.getParentCompanyId();

        // Collect company IDs to process: always include the current company.
        // When the current company IS the parent, also include all subsidiaries so
        // their INTERCO-PARENT and INTERCO-FREIGHT vouchers are repaired too.
        const companyIdsToProcess: number[] = [companyId];
        if (parentCompanyId && companyId === parentCompanyId) {
          const subsidiaryConfigs = await db
            .select({ sourceCompanyId: intercompanyPosConfigs.sourceCompanyId })
            .from(intercompanyPosConfigs)
            .where(eq(intercompanyPosConfigs.destCompanyId, parentCompanyId));
          for (const cfg of subsidiaryConfigs) {
            if (cfg.sourceCompanyId && !companyIdsToProcess.includes(cfg.sourceCompanyId)) {
              companyIdsToProcess.push(cfg.sourceCompanyId);
            }
          }
        }

        // Fetch all POs for all relevant companies
        const allPos = await db
          .select()
          .from(purchaseOrders)
          .where(inArray(purchaseOrders.companyId, companyIdsToProcess));

        // Build a containerId → containerNumber map across ALL companies.
        // POs may reference containers owned by the parent company or another
        // entity — restricting by companyIdsToProcess causes
        // containerNumberMap.get(poContainerId) to return undefined, making
        // cNum fall back to String(containerId) and breaking the INTERCO
        // journal lookup in syncIntercoParentVoucher.
        const allContainerRows = await db
          .select({ id: containers.id, containerNumber: containers.containerNumber })
          .from(containers);
        const containerNumberMap = new Map<number, string>(allContainerRows.map((c) => [c.id, c.containerNumber]));

        let scannedPOs = 0;
        let updatedLocalVouchers = 0;
        let updatedParentVouchers = 0;
        let updatedFreightVouchers = 0;
        let updatedContainerCharges = 0;
        const skipped: string[] = [];
        const notFoundParentVouchers: string[] = [];
        const missingParentFreightAccount: string[] = [];
        const errors: string[] = [];

        for (const po of allPos) {
          scannedPOs++;
          try {
            // Recalculate exact amounts
            const { grossTotal, intercoTotal } = calcPoAmountsExact({
              itemsTotal: po.itemsTotal,
              freight: po.freight,
              surcharge: po.surcharge,
              fumigation: po.fumigation,
              documentCharges: po.documentCharges,
              discount: po.discount,
              otherCharges: po.otherCharges,
              freightPaidBy: po.freightPaidBy,
            });

            if (grossTotal.lte(0)) {
              skipped.push(`PO ${po.poNumber}: total is 0 — skipped`);
              continue;
            }

            // Resolve freight info from calcPoAmounts result
            const poFreightPaidBy: string = po.freightPaidBy || "supplier";
            const poFreight = toMoney(po.freight);
            const poFreightParentAccountId: number | null = po.freightParentAccountId
              ? Number(po.freightParentAccountId)
              : null;
            const poFreightOwnAccountId: number | null = po.freightOwnAccountId ? Number(po.freightOwnAccountId) : null;
            const hasParentFreight = poFreightPaidBy === "parent" && poFreight.gt(0) && !!poFreightParentAccountId;
            const hasOwnFreight = poFreightPaidBy === "own" && poFreight.gt(0) && !!poFreightOwnAccountId;
            const hasEmbeddedFreight = hasParentFreight || hasOwnFreight;
            const freightAccountId = hasParentFreight
              ? poFreightParentAccountId
              : hasOwnFreight
                ? poFreightOwnAccountId
                : null;

            const poContainerId = po.containerId;
            const cNum = poContainerId
              ? (containerNumberMap.get(poContainerId) ?? String(poContainerId))
              : String(po.id);
            const isSameCompanyPo = !parentCompanyId || po.companyId === parentCompanyId;

            // ── Fix the local purchase voucher ────────────────────────────────
            // Expected total:
            //   parent-freight (with or without account) → grossTotal (child owes parent the full amount)
            //   own-embedded freight                     → grossTotal
            //   all other cases                          → intercoTotal (goods only)
            const expectedLocalTotal =
              hasEmbeddedFreight || (poFreightPaidBy === "parent" && poFreight.gt(0)) ? grossTotal : intercoTotal;
            if (po.voucherId) {
              const [localVoucher] = await db
                .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
                .from(vouchers)
                .where(eq(vouchers.id, po.voucherId))
                .limit(1);

              if (localVoucher) {
                const currentLocalTotal = toMoney(localVoucher.totalAmount);
                const entries = await db
                  .select()
                  .from(voucherEntries)
                  .where(eq(voucherEntries.voucherId, po.voucherId));

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
                  await db.transaction(async (tx) => {
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
                            .set({ debitAmount: moneyString(grossTotal), creditAmount: "0" })
                            .where(eq(voucherEntries.id, purchasesEntryId));
                        if (mainCrEntryId !== null)
                          await tx
                            .update(voucherEntries)
                            .set({ creditAmount: moneyString(intercoTotal), debitAmount: "0" })
                            .where(eq(voucherEntries.id, mainCrEntryId));
                        const _syncAllFreightNarration = `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`;
                        if (freightCrEntryId !== null) {
                          await tx
                            .update(voucherEntries)
                            .set({
                              creditAmount: moneyString(poFreight),
                              debitAmount: "0",
                              ledgerAccountId: poFreightParentAccountId!,
                              narration: _syncAllFreightNarration,
                            })
                            .where(eq(voucherEntries.id, freightCrEntryId));
                        } else {
                          await tx.insert(voucherEntries).values({
                            voucherId: poVoucherId,
                            ledgerAccountId: poFreightParentAccountId!,
                            debitAmount: "0",
                            creditAmount: moneyString(poFreight),
                            narration: _syncAllFreightNarration,
                          });
                        }
                        updatedFreightVouchers++;
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
                            .set({ creditAmount: moneyString(grossTotal), debitAmount: "0" })
                            .where(eq(voucherEntries.id, parentCreditEntryId));
                        } else if (parentCreditAcctId) {
                          await tx.insert(voucherEntries).values({
                            voucherId: poVoucherId,
                            ledgerAccountId: parentCreditAcctId,
                            debitAmount: "0",
                            creditAmount: moneyString(grossTotal),
                            narration: `PO ${po.poNumber} - Credit to parent`,
                          });
                        }

                        if (purchasesAcctId) {
                          await tx.insert(voucherEntries).values([
                            {
                              voucherId: poVoucherId,
                              ledgerAccountId: purchasesAcctId,
                              debitAmount: moneyString(intercoTotal),
                              creditAmount: "0",
                              narration: `${po.poNumber}`,
                            },
                            {
                              voucherId: poVoucherId,
                              ledgerAccountId: purchasesAcctId,
                              debitAmount: moneyString(poFreight),
                              creditAmount: "0",
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
                              .set({ debitAmount: moneyString(intercoTotal), creditAmount: "0" })
                              .where(eq(voucherEntries.id, entry.id));
                          }
                        } else if (isCredit) {
                          if (entry.ledgerAccountId === freightAccountId) {
                            freightCrFound = true;
                            await tx
                              .update(voucherEntries)
                              .set({ creditAmount: moneyString(poFreight) })
                              .where(eq(voucherEntries.id, entry.id));
                          } else {
                            await tx
                              .update(voucherEntries)
                              .set({ creditAmount: moneyString(intercoTotal), debitAmount: "0" })
                              .where(eq(voucherEntries.id, entry.id));
                          }
                        }
                      }
                      if (!freightCrFound && purchasesAcctId) {
                        await tx.insert(voucherEntries).values([
                          {
                            voucherId: poVoucherId,
                            ledgerAccountId: purchasesAcctId,
                            debitAmount: moneyString(poFreight),
                            creditAmount: "0",
                            narration: `Freight - ${po.poNumber}${cNum && cNum !== String(po.id) ? ` (${cNum})` : ""}`,
                          },
                          {
                            voucherId: poVoucherId,
                            ledgerAccountId: freightAccountId,
                            debitAmount: "0",
                            creditAmount: moneyString(poFreight),
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
                            .set({ debitAmount: moneyString(expectedLocalTotal), creditAmount: "0" })
                            .where(eq(voucherEntries.id, entry.id));
                        } else {
                          await tx
                            .update(voucherEntries)
                            .set({ creditAmount: moneyString(expectedLocalTotal), debitAmount: "0" })
                            .where(eq(voucherEntries.id, entry.id));
                        }
                      }
                    }
                  });
                  updatedLocalVouchers++;
                }
              }
            }

            // ── Fix the parent INTERCO-PARENT voucher ───────────────────────
            if (parentCompanyId && po.companyId !== parentCompanyId) {
              const svResult = await syncIntercoParentVoucher(
                db,
                po.poNumber,
                grossTotal,
                cNum,
                hasParentFreight
                  ? {
                      freightAmount: poFreight,
                      freightParentAccountId: poFreightParentAccountId!,
                      subsidiaryCompanyId: po.companyId,
                    }
                  : undefined
              );
              if (svResult.updated) {
                updatedParentVouchers++;
              } else if (!svResult.found) {
                notFoundParentVouchers.push(`PO ${po.poNumber}: no INTERCO-PARENT voucher in parent company`);
              }
            }
            // ── Stale FREIGHT- voucher cleanup / missing parent freight account warning ──
            const freightVoucherNum = `FREIGHT-${cNum}-${po.poNumber}`;
            if (poFreightPaidBy === "parent" && poFreight.gt(0) && !po.freightParentAccountId) {
              missingParentFreightAccount.push(
                `PO ${po.poNumber}: freight set to parent-paid but no parent account configured`
              );
            }

            // Freight is now embedded inside the purchase voucher — delete any stale FREIGHT- voucher.
            // Search in the PO's own company, NOT the session company, so the parent company's
            // freight vouchers are never accidentally deleted when processing subsidiary POs.
            {
              const [staleFV] = await db
                .select({ id: vouchers.id })
                .from(vouchers)
                .where(and(eq(vouchers.companyId, po.companyId), eq(vouchers.voucherNumber, freightVoucherNum)))
                .limit(1);
              if (staleFV) {
                // Wave 16 (A): retired (soft delete with lines, audited), not hard-deleted.
                await db.transaction((tx) =>
                  retireVouchersTx(tx, {
                    companyId: po.companyId,
                    voucherIds: [staleFV.id],
                    reason: "stale-freight-voucher-sync",
                    actor: sessionRetirementActor(req),
                  })
                );
                updatedFreightVouchers++;
              }
            }

            // ── Stale PARENT-FREIGHT- journal cleanup (same-company POs only) ──
            // These journals were wrongly created when a same-company PO had parent freight.
            // Freight is embedded in the PO voucher, so the standalone journal is wrong — delete it.
            if (isSameCompanyPo && poFreightPaidBy === "parent") {
              const parentFreightVoucherNum = `PARENT-FREIGHT-${po.poNumber}`;
              const [stalePFV] = await db
                .select({ id: vouchers.id })
                .from(vouchers)
                .where(and(eq(vouchers.companyId, po.companyId), eq(vouchers.voucherNumber, parentFreightVoucherNum)))
                .limit(1);
              if (stalePFV) {
                // Wave 16 (A): retired (soft delete with lines, audited), not hard-deleted.
                await db.transaction((tx) =>
                  retireVouchersTx(tx, {
                    companyId: po.companyId,
                    voucherIds: [stalePFV.id],
                    reason: "stale-parent-freight-journal-sync",
                    actor: sessionRetirementActor(req),
                  })
                );
                updatedFreightVouchers++;
                logger.info(`[SyncAll] Deleted stale PARENT-FREIGHT journal for same-company PO ${po.poNumber}`);
              }
            }

            // INTERCO-FREIGHT vouchers are no longer created — freight is recorded
            // directly inside the purchase voucher. Legacy ones are left in place
            // (they can be deleted manually from the daybook if no longer needed).
          } catch (poErr: unknown) {
            errors.push(`PO ${po.poNumber}: ${getErrorMessage(poErr)}`);
            logger.error(`[SyncAll] Error processing PO ${po.poNumber}:`, { error: poErr });
          }
        }

        // ── Update container totals ──────────────────────────────────────────
        let updatedContainers = 0;
        const containerIds = [...new Set(allPos.map((p) => p.containerId))];
        for (const cid of containerIds) {
          try {
            const containerPos = allPos.filter((p) => p.containerId === cid);
            const sumField = (field: "itemsTotal" | ChargeField) => sumMoney(containerPos.map((p) => p[field]));
            const chargeSums = Object.fromEntries(CHARGE_FIELDS.map((f) => [f, sumField(f)])) as Record<
              ChargeField,
              Decimal
            >;
            const containerItemsTotal = sumField("itemsTotal");
            const containerChargesTotal = chargeSums.freight
              .plus(chargeSums.surcharge)
              .plus(chargeSums.fumigation)
              .plus(chargeSums.documentCharges)
              .minus(chargeSums.discount)
              .plus(chargeSums.otherCharges);
            const containerGrandTotal = containerItemsTotal.plus(containerChargesTotal);

            const [existingContainer] = await db
              .select({
                id: containers.id,
                itemsTotal: containers.itemsTotal,
                chargesTotal: containers.chargesTotal,
                grandTotal: containers.grandTotal,
              })
              .from(containers)
              .where(eq(containers.id, cid))
              .limit(1);

            if (existingContainer) {
              const mismatch =
                differs(toMoney(existingContainer.itemsTotal), containerItemsTotal) ||
                differs(toMoney(existingContainer.chargesTotal), containerChargesTotal) ||
                differs(toMoney(existingContainer.grandTotal), containerGrandTotal);
              if (mismatch) {
                await db
                  .update(containers)
                  .set({
                    itemsTotal: moneyString(containerItemsTotal),
                    chargesTotal: moneyString(containerChargesTotal),
                    grandTotal: moneyString(containerGrandTotal),
                  })
                  .where(eq(containers.id, cid));
                updatedContainers++;
              }
            }

            // ── Repair container_charges rows ────────────────────────────────
            // Aggregate each charge type across all POs for this container
            if (cid) {
              const summedCharges: { chargeType: string; amount: Decimal }[] = [
                { chargeType: "Freight", amount: chargeSums.freight },
                { chargeType: "Surcharge", amount: chargeSums.surcharge },
                { chargeType: "Fumigation", amount: chargeSums.fumigation },
                { chargeType: "Document Charges", amount: chargeSums.documentCharges },
                { chargeType: "Discount", amount: chargeSums.discount.negated() },
                { chargeType: "Other Charges", amount: chargeSums.otherCharges },
              ];
              for (const { chargeType, amount } of summedCharges) {
                const [existingCharge] = await db
                  .select({ id: containerCharges.id, amount: containerCharges.amount })
                  .from(containerCharges)
                  .where(and(eq(containerCharges.containerId, cid), eq(containerCharges.chargeType, chargeType)))
                  .limit(1);
                if (amount.isZero()) {
                  if (existingCharge) {
                    await db.delete(containerCharges).where(eq(containerCharges.id, existingCharge.id));
                    updatedContainerCharges++;
                  }
                } else {
                  if (differs(toMoney(existingCharge?.amount), amount)) {
                    if (existingCharge) {
                      await db
                        .update(containerCharges)
                        .set({ amount: moneyString(amount) })
                        .where(eq(containerCharges.id, existingCharge.id));
                    } else {
                      await db
                        .insert(containerCharges)
                        .values({ containerId: cid, chargeType, amount: moneyString(amount) });
                    }
                    updatedContainerCharges++;
                  }
                }
              }
            }
          } catch (cErr: unknown) {
            errors.push(`Container ${cid}: ${getErrorMessage(cErr)}`);
          }
        }

        const scannedContainers = containerIds.length;
        logger.info(
          `[SyncAll] Done. POs=${scannedPOs} Containers=${scannedContainers} LocalVouchers=${updatedLocalVouchers} ParentVouchers=${updatedParentVouchers} FreightVouchers=${updatedFreightVouchers} ContainerCharges=${updatedContainerCharges} ContainerTotals=${updatedContainers} Skipped=${skipped.length} NotFound=${notFoundParentVouchers.length} Errors=${errors.length}`
        );

        res.json({
          scannedPOs,
          scannedContainers,
          updatedLocalVouchers,
          updatedParentVouchers,
          updatedFreightVouchers,
          updatedContainerCharges,
          updatedContainers,
          skipped,
          notFoundParentVouchers,
          missingParentFreightAccount,
          errors,
          message: `Scanned ${scannedPOs} POs. Updated ${updatedLocalVouchers} local vouchers, ${updatedParentVouchers} parent JVs, ${updatedContainers} container totals.`,
        });
      } catch (error: unknown) {
        logger.error("[SyncAll] Fatal error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Bulk import container tracking from Excel data
}
