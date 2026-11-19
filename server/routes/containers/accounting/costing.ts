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
import { containers, containerCharges, purchaseOrders, vouchers, intercompanyPosConfigs } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  calcPoAmountsExact,
  differsByMoreThanTolerance as differs,
  syncIntercoParentVoucher,
} from "../containerHelpers";
import { moneyString, sumMoney, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { resyncPoVoucherCosting } from "./costingVoucherResync";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

const syncAllVouchersInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

const CHARGE_FIELDS = ["freight", "surcharge", "fumigation", "documentCharges", "discount", "otherCharges"] as const;
type ChargeField = (typeof CHARGE_FIELDS)[number];

export function registerContainerCostingRoutes(app: Express) {
  app.post(
    "/api/containers/sync-all-vouchers",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Developer"),
    validateRequest(syncAllVouchersInput),
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

        const poCounts = {
          scannedPOs: 0,
          updatedLocalVouchers: 0,
          updatedParentVouchers: 0,
          updatedFreightVouchers: 0,
        };
        let updatedContainerCharges = 0;
        const skipped: string[] = [];
        const notFoundParentVouchers: string[] = [];
        const missingParentFreightAccount: string[] = [];
        const errors: string[] = [];

        for (const po of allPos) {
          poCounts.scannedPOs++;
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
            await resyncPoVoucherCosting({
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
            });

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
                poCounts.updatedParentVouchers++;
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
                poCounts.updatedFreightVouchers++;
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
                poCounts.updatedFreightVouchers++;
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
        const { scannedPOs, updatedLocalVouchers, updatedParentVouchers, updatedFreightVouchers } = poCounts;
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
        logger.error("[SyncAll] Fatal error:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Bulk import container tracking from Excel data
}
