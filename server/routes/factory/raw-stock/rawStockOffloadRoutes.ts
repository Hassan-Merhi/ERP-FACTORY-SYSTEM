import Decimal from "decimal.js";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { logAudit } from "../../helpers/auditHelpers";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { applyOffloadMovingAverage } from "../../../services/factory/rawStockLockedRate";
import { resolveStoredFxRate, resolveStoredFxRateOrThrow } from "../../../services/factory/currencyConversion";
import { writeDaybookEntry, getOrFetchFxRateToUsd } from "../_helpers";
import {
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryContainerCommissions,
  voucherEntries,
  factoryDaybookEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factoryContainerReceipts,
} from "@shared/schema";
import { eq, and, or, inArray, ilike } from "drizzle-orm";
import { registerRawStockReverseOffloadRoute } from "./rawStockReverseOffloadRoute";
import { computeOffloadCosting } from "./offloadCosting";
import { applySubsequentReceipt } from "./subsequentReceipt";

export function registerRawStockOffloadRoutes(app: Express) {
  app.post("/api/factory/raw-stock/offload", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        containerId,
        receivedKg,
        costPerKg,
        commission,
        currencyCode: reqCurrencyCode,
        fxRateToUsd: reqFxRate,
        freight: reqFreight,
        freightAccountId: reqFreightAccountId,
        freightSupplierId: reqFreightSupplierId,
        freightCurrencyCode: reqFreightCurrencyCode,
        freightFxRate: reqFreightFxRate,
        otherCharges: reqOtherCharges,
        otherChargesAccountId: reqOtherChargesAccountId,
        otherChargesSupplierId: reqOtherChargesSupplierId,
        otherChargesCurrencyCode: reqOtherChargesCurrencyCode,
        otherChargesFxRate: reqOtherChargesFxRate,
        dutyAmount: reqDutyAmount,
        dutyAccountId: reqDutyAccountId,
        dutyStatus: reqDutyStatus,
        dutyNotes: reqDutyNotes,
        additionalCharges: reqAdditionalCharges,
        offloadDate: reqOffloadDate,
        mixBatchAllocations: reqMixBatchAllocations,
        destination: reqDestination,
        idempotencyKey,
      } = req.body;
      if (!containerId) return res.status(400).json({ message: "Container ID is required" });

      // Validate receivedKg upfront — required for both first and subsequent receipts.
      // An explicit positive finite value is mandatory; the old `receivedKg || declaredKg`
      // fallback silently accepted a missing receivedKg and treated it as a full offload.
      if (!receivedKg || !Number.isFinite(parseFloat(receivedKg || "")) || parseFloat(receivedKg) <= 0) {
        return res.status(400).json({ message: "receivedKg must be a positive finite number" });
      }

      const [container] = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });

      const [existingRawStock] = await db
        .select()
        .from(factoryRawStock)
        .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

      // A PARTIALLY_RECEIVED container may receive additional kg (subsequent receipt).
      // A fully OFFLOADED container (cumulative received >= declared) must not.
      const isSubsequentReceipt = !!existingRawStock;
      if (isSubsequentReceipt && container.status === "OFFLOADED") {
        return res.status(400).json({ message: "This container has already been fully offloaded" });
      }

      const currencyCode = reqCurrencyCode || container.currencyCode || "USD";
      const today = getClientDate(req);
      const offloadDate = reqOffloadDate || today;
      const mixBatchAllocationsArr = Array.isArray(reqMixBatchAllocations) ? reqMixBatchAllocations : [];

      let fxRate: number;
      if (reqFxRate && parseFloat(reqFxRate) > 0) {
        // User explicitly set the FX rate — always honour it
        fxRate = parseFloat(reqFxRate);
      } else if (currencyCode === "USD") {
        fxRate = 1;
      } else {
        try {
          fxRate = parseFloat(await getOrFetchFxRateToUsd(companyId, currencyCode, offloadDate));
        } catch (err: unknown) {
          // Do NOT silently default to 1 for a non-USD offload — that would understate
          // (or overstate) the USD landed cost by the entire FX differential with no
          // trace of why. The container's own fxRateToUsd is only a legitimate fallback
          // if it was itself explicitly set (not left at the schema default of "1" for
          // a non-USD currency, which means "never actually set").
          const { fxRate: containerRate, looksSet: containerRateLooksSet } = resolveStoredFxRate(
            container.currencyCode,
            container.fxRateToUsd,
            container.fxRateConfirmed
          );
          if (!containerRateLooksSet) {
            return res.status(400).json({
              message: `No valid FX rate available for ${currencyCode} on ${offloadDate}, and the container has no explicitly-set fxRateToUsd to fall back on. Provide fxRateToUsd explicitly to offload this container. (${getErrorMessage(err)})`,
            });
          }
          fxRate = containerRate;
        }
      }

      const declaredKg = container.totalKg || "0";
      const dReceivedKg = new Decimal(receivedKg);
      const baseCostPerKg = costPerKg || container.ratePerKg || "0";
      const differenceKg = new Decimal(declaredKg).minus(dReceivedKg).toDecimalPlaces(3).toFixed(3);

      // Fall back to the container's own supplier for freight payee when the offload
      // request didn't explicitly resend one. Container creation and the PATCH freight-sync
      // route both credit container.supplierId whenever freightPaidBy='supplier' (the
      // default) without requiring a separate freightSupplierId to be selected again — the
      // offload form should honor the same default, or freight silently falls into the
      // no-payee ledger branch (Dr Factory Charges Payable / Cr Freight), which nets the
      // freight expense to zero and leaves an unresolved balance in Charges Payable.
      // Resolve who receives the freight credit.
      // Only auto-assign a supplier if the container has a dedicated freight
      // supplier (freightSupplierId) — NEVER fall back to the material supplier
      // (container.supplierId), because freight may be paid via an own account
      // (e.g. Embassy Shipping) that has nothing to do with the material supplier.
      const effectiveFreightSupplierId: number | null = reqFreightSupplierId
        ? parseInt(reqFreightSupplierId)
        : !reqFreightAccountId && container.freightSupplierId
          ? container.freightSupplierId
          : null;

      const freightVal = parseFloat(reqFreight || "0");
      const otherChargesVal = parseFloat(reqOtherCharges || "0");
      const additionalChargesArr = Array.isArray(reqAdditionalCharges) ? reqAdditionalCharges : [];
      const dutyVal = reqDutyStatus === "CONFIRMED" ? parseFloat(reqDutyAmount || "0") : 0;
      const dutyStatus = reqDutyStatus || "NONE";

      // ── Commission computation (DB insert deferred into the transaction) ──────
      let commissionRecord: typeof factoryContainerCommissions.$inferSelect | null = null;
      const costing = await computeOffloadCosting({
        companyId,
        containerId,
        container,
        currencyCode,
        fxRate,
        offloadDate,
        declaredKg,
        dReceivedKg,
        baseCostPerKg,
        commission,
        freightVal,
        otherChargesVal,
        additionalChargesArr,
        dutyVal,
        dutyStatus,
        effectiveFreightSupplierId,
        reqFreightCurrencyCode,
        reqFreightFxRate,
        reqFreightAccountId,
        reqOtherChargesCurrencyCode,
        reqOtherChargesFxRate,
        reqOtherChargesSupplierId,
        reqOtherChargesAccountId,
      });
      if (!costing.ok) return res.status(costing.httpStatus).json(costing.body);
      const {
        commTotalVal,
        commCurrencyForUsd,
        commFxRateForUsd,
        commInsertValues,
        freightCcy,
        freightFxRateVal,
        freightUsd,
        ocCcy,
        ocFxRateVal,
        ocUsd,
        dInclusiveCostPerKg,
        dCostPerKgUsd,
        finalPayableAmount,
        finalPayableAmountUsd,
        newStatus,
        chargesPayableAcctId,
        freightExpenseAcctId,
        ocExpenseAcctId,
      } = costing;

      // ── Single atomic transaction: all DB writes happen here or not at all ────
      let rawStock: any;

      await db.transaction(async (tx) => {
        // ── SUBSEQUENT RECEIPT PATH ───────────────────────────────────────────────
        // When a raw-stock row already exists (PARTIALLY_RECEIVED container), we only:
        //   1. Apply the moving-average using the FIXED rate from the first offload
        //   2. Increment raw-stock receivedKg
        //   3. Optionally insert mix-batch sources at the same fixed rate
        //   4. Update the container's cumulative actualReceivedKg and status
        //   5. Record this event in factory_container_receipts
        // Financial posting (commission, daybook, freight/OC vouchers) already happened
        // on the first receipt — do NOT repeat it here.
        if (isSubsequentReceipt) {
          // Continuation receipt: stock movement only, no financial posting.
          rawStock = await applySubsequentReceipt({
            tx,
            companyId,
            containerId,
            container,
            currencyCode,
            fxRate,
            offloadDate,
            declaredKg,
            dReceivedKg,
            mixBatchAllocationsArr,
            reqDestination,
            idempotencyKey,
            userId: req.session.userId || null,
          });
          return; // Skip all other financial posting — already done on first receipt
        }

        // ── FIRST RECEIPT PATH ───────────────────────────────────────────────────
        // 0. Update the supplier's locked raw-material rate using the moving-average
        //    formula, BEFORE inserting the new raw-stock row, so "remaining kg" reflects
        //    stock immediately before this offload (already-consumed stock never
        //    re-enters the average). Row-locks the supplier to serialize concurrent
        //    offloads. Only applies to a real supplier — manual/no-supplier containers
        //    have no locked rate to maintain.
        // Capture newLockedRate so mix-batch allocations created in this same
        // transaction use the post-offload supplier moving-average rate, not the
        // individual container's landed cost (which is correct only for raw-stock
        // valuation, not for supplier-level blended cost tracking).
        let firstReceiptNewLockedRate = dCostPerKgUsd.toNumber(); // fallback for no-supplier
        if (container.supplierId) {
          const movAvgResult = await applyOffloadMovingAverage(tx, {
            companyId,
            supplierId: container.supplierId,
            newReceivedKg: dReceivedKg.toNumber(),
            newContainerLandedCostPerKgUsd: dCostPerKgUsd.toNumber(),
          });
          firstReceiptNewLockedRate = movAvgResult.newLockedRate;
        }

        // 1. Commission INSERT
        if (commInsertValues) {
          [commissionRecord] = await tx.insert(factoryContainerCommissions).values(commInsertValues).returning();
        }

        // 2. Raw stock INSERT
        [rawStock] = await tx
          .insert(factoryRawStock)
          .values({
            companyId,
            containerId,
            receivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
            costPerKg: dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6),
            costPerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
          })
          .returning();

        // 3. Record the first receipt event (enables idempotency on retries and audit history).
        //    The subsequent-receipt idempotency check looks for this row by idempotencyKey.
        await tx.insert(factoryContainerReceipts).values({
          companyId,
          containerId,
          receiptDate: offloadDate,
          receivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
          cumulativeReceivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
          fixedCostPerKg: dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6),
          fixedCostPerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
          receiptValue: dReceivedKg.times(dInclusiveCostPerKg).toDecimalPlaces(6).toFixed(6),
          receiptValueUsd: dReceivedKg.times(dCostPerKgUsd).toDecimalPlaces(6).toFixed(6),
          currencyCode,
          fxRateToUsd: String(fxRate),
          createdBy: req.session.userId || null,
          idempotencyKey: idempotencyKey || null,
        });

        // 4. Mix batch source INSERTs
        //    Supplier-backed sources must be priced at the post-offload supplier
        //    moving-average rate (firstReceiptNewLockedRate), NOT the container's
        //    individual landed cost (dCostPerKgUsd). The container's own USD rate
        //    is the canonical raw-stock valuation; the supplier moving-average is
        //    the correct blended rate for all material consumed from that supplier.
        //    FIFO / containerId is stored for provenance only.
        for (const alloc of mixBatchAllocationsArr) {
          const allocKg = parseFloat(alloc.weightKg || "0");
          if (!alloc.mixBatchId || allocKg <= 0) continue;
          const dAllocKg = new Decimal(allocKg);
          // Rate: supplier moving-average for supplier-backed containers;
          //       container's own USD rate for no-supplier containers.
          const dAllocRate = container.supplierId ? new Decimal(firstReceiptNewLockedRate) : dCostPerKgUsd;
          // sourceType: SUPPLIER_FIFO when supplierId + containerId present,
          //             CONTAINER_DIRECT when no supplier.
          const firstSrcType = container.supplierId ? "SUPPLIER_FIFO" : "CONTAINER_DIRECT";
          await tx.insert(factoryMixBatchSources).values({
            mixBatchId: parseInt(alloc.mixBatchId),
            containerId,
            supplierId: container.supplierId || null,
            sourceType: firstSrcType,
            weightKg: String(allocKg),
            costPerKg: dAllocRate.toDecimalPlaces(6).toFixed(6),
            totalCost: dAllocKg.times(dAllocRate).toDecimalPlaces(6).toFixed(6),
            inventorySupplierId: container.supplierId || null,
          });
        }

        // 5. Container UPDATE (status + financials + pre-offload snapshot)
        await tx
          .update(factoryContainers)
          .set({
            status: newStatus,
            declaredKg: String(declaredKg),
            actualReceivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
            finalPayableAmount,
            differenceKg,
            currencyCode,
            fxRateToUsd: String(fxRate),
            // fxRate was already resolved above (explicit rate, USD, a fetched live
            // rate, or the container's own already-confirmed rate) — never left at the
            // unset default — so this offload's rate is confirmed. Without this flag,
            // every freshly-offloaded non-USD container would still read back as
            // "unresolved" everywhere fxRateConfirmed is checked (recalc, reverse-offload,
            // supplier balance reconciliation), even though the rate is known-good.
            fxRateConfirmed: true,
            fxRateToUsdOffload: String(fxRate),
            fxRateDateOffload: offloadDate,
            ratePerKgUsd: dCostPerKgUsd.toDecimalPlaces(6).toFixed(6),
            finalPayableAmountUsd,
            freight: String(freightVal),
            freightAccountId: reqFreightAccountId ? parseInt(reqFreightAccountId) : null,
            freightSupplierId: effectiveFreightSupplierId,
            // Record how freight was paid so the supplier balance formula
            // (isSupplierPaidFreight) does not default to "supplier" and
            // wrongly include own-account freight in the supplier's payable.
            freightPaidBy: effectiveFreightSupplierId
              ? "supplier"
              : reqFreightAccountId
                ? "own"
                : container.freightPaidBy || "supplier",
            // When own-account is used, persist the credit account so the
            // reverse-offload can correctly restore it without falling back
            // to the material supplier.
            freightOwnAccountId:
              !effectiveFreightSupplierId && reqFreightAccountId ? parseInt(reqFreightAccountId) : null,
            otherCharges: String(otherChargesVal),
            otherChargesCurrencyCode: ocCcy || null,
            otherChargesAccountId: reqOtherChargesAccountId ? parseInt(reqOtherChargesAccountId) : null,
            otherChargesSupplierId: reqOtherChargesSupplierId ? parseInt(reqOtherChargesSupplierId) : null,
            commissionAmount: commTotalVal > 0 ? String(commTotalVal) : container.commissionAmount || "0",
            commissionCurrencyCode: commTotalVal > 0 ? commCurrencyForUsd : container.commissionCurrencyCode || "USD",
            // Persist the resolved commission-specific FX rate so computeCorrectContainerCost
            // and repair scripts can use it without re-fetching.  When there is no commission
            // (commTotalVal == 0) clear all three fields so stale pre-offload values don't linger.
            commissionFxRateToUsd: commTotalVal > 0 ? String(commFxRateForUsd) : null,
            commissionFxRateConfirmed: commTotalVal > 0,
            commissionFxRateDate: commTotalVal > 0 ? offloadDate : null,
            dutyAmount: dutyStatus !== "NONE" ? String(parseFloat(reqDutyAmount || "0")) : null,
            dutyAccountId: reqDutyAccountId ? parseInt(reqDutyAccountId) : null,
            dutyStatus,
            dutyNotes: reqDutyNotes || null,
            preOffloadFreight: container.freight || "0",
            preOffloadFreightCurrencyCode: container.freightCurrencyCode || container.currencyCode || "USD",
            preOffloadFreightAccountId: container.freightAccountId || null,
            preOffloadFreightSupplierId: container.freightSupplierId || null,
            preOffloadOtherCharges: container.otherCharges || "0",
            preOffloadOtherChargesAccountId: container.otherChargesAccountId || null,
            preOffloadOtherChargesSupplierId: container.otherChargesSupplierId || null,
            preOffloadStatus: container.status,
            preOffloadCommissionAmount: container.commissionAmount || "0",
            preOffloadCommissionCurrencyCode: container.commissionCurrencyCode || "USD",
            preOffloadCommissionAccountId: container.commissionAccountId || null,
            preOffloadCommissionSupplierId: container.commissionSupplierId || null,
            preOffloadCommissionNotes: container.commissionNotes || null,
            destination: reqDestination ? String(reqDestination).trim() : container.destination || null,
            updatedAt: new Date(),
          })
          .where(eq(factoryContainers.id, containerId));

        // 6. Additional charges INSERTs
        const insertedAdditionalCharges = [];
        if (additionalChargesArr.length > 0) {
          for (const charge of additionalChargesArr) {
            if (parseFloat(charge.amount || "0") > 0) {
              const [inserted] = await tx
                .insert(factoryOffloadAdditionalCharges)
                .values({
                  companyId,
                  containerId,
                  description: charge.description || "Additional Charge",
                  amount: String(charge.amount),
                  currencyCode: charge.currencyCode || currencyCode,
                  fxRateToUsd: String(charge.fxRateToUsd || (currencyCode === "USD" ? "1" : String(fxRate))),
                  // Same reasoning as the container/commission fix above: the rate used
                  // here is either explicitly supplied on the charge or the already-
                  // resolved offload fxRate, never an unset default — mark it confirmed
                  // so downstream reads (recalc, reversal, reconciliation) don't treat
                  // a known-good rate as unresolved.
                  fxRateConfirmed: true,
                  ledgerAccountId: charge.ledgerAccountId ? parseInt(charge.ledgerAccountId) : null,
                  supplierId: charge.supplierId ? parseInt(charge.supplierId) : null,
                })
                .returning();
              insertedAdditionalCharges.push(inserted);
            }
          }
        }

        // 7. Daybook entries
        // Use the value of THIS RECEIPT's kg (incremental), not the full container
        // value. For a fully-received container receivedKg == declaredKg so the result
        // is identical. For a partial first receipt, posting the full container value
        // would overstate the daybook — only what we actually received today is an
        // economic event today.
        await writeDaybookEntry(tx, {
          companyId,
          txDate: offloadDate,
          txType: "OFFLOAD_RAW_STOCK",
          referenceId: rawStock.id,
          referenceTable: "factory_raw_stock",
          description: `Offloaded container ${container.containerNumber}: ${dReceivedKg.toDecimalPlaces(3).toFixed(3)} kg at ${dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6)}/kg (inclusive)`,
          currencyCode,
          amountCurrency: dReceivedKg.times(dInclusiveCostPerKg).toDecimalPlaces(6).toNumber(),
          fxRateToUsd: fxRate,
          metaJson: JSON.stringify({ containerId, sourceType: "BASE_MATERIAL" }),
        });
        if (commissionRecord) {
          await writeDaybookEntry(tx, {
            companyId,
            txDate: offloadDate,
            txType: "COMMISSION",
            referenceId: commissionRecord.id,
            referenceTable: "factory_container_commissions",
            description: `Commission for ${commissionRecord.personName} on container ${container.containerNumber}`,
            currencyCode: commissionRecord.currencyCode || "USD",
            amountCurrency: parseFloat(commissionRecord.commissionTotal),
            fxRateToUsd: resolveStoredFxRateOrThrow(
              commissionRecord.currencyCode,
              commissionRecord.fxRateToUsd,
              commissionRecord.fxRateConfirmed
            ),
            metaJson: JSON.stringify({ containerId, sourceType: "COMMISSION", commissionId: commissionRecord.id }),
          });
        }
        if (freightVal > 0) {
          await writeDaybookEntry(tx, {
            companyId,
            txDate: offloadDate,
            txType: "FREIGHT",
            referenceId: containerId,
            referenceTable: "factory_containers",
            description: `Freight on container ${container.containerNumber}`,
            currencyCode: freightCcy,
            amountCurrency: freightVal,
            fxRateToUsd: freightCcy === "USD" ? 1 : freightFxRateVal,
            metaJson: JSON.stringify({ containerId, sourceType: "FREIGHT" }),
          });
        }
        if (otherChargesVal > 0) {
          await writeDaybookEntry(tx, {
            companyId,
            txDate: offloadDate,
            txType: "OTHER_CHARGE",
            referenceId: containerId,
            referenceTable: "factory_containers",
            description: `Other charges on container ${container.containerNumber}`,
            currencyCode: ocCcy,
            amountCurrency: otherChargesVal,
            fxRateToUsd: ocCcy === "USD" ? 1 : ocFxRateVal,
            metaJson: JSON.stringify({ containerId, sourceType: "CONTAINER_OC" }),
          });
        }
        if (dutyVal > 0) {
          await writeDaybookEntry(tx, {
            companyId,
            txDate: offloadDate,
            txType: "DUTY",
            referenceId: containerId,
            referenceTable: "factory_containers",
            description: `Duty on container ${container.containerNumber}`,
            currencyCode,
            amountCurrency: dutyVal,
            fxRateToUsd: fxRate,
            metaJson: JSON.stringify({ containerId, sourceType: "DUTY" }),
          });
        }
        for (const insertedCharge of insertedAdditionalCharges) {
          const chargeAmount = parseFloat(insertedCharge.amount || "0");
          if (chargeAmount > 0) {
            await writeDaybookEntry(tx, {
              companyId,
              txDate: offloadDate,
              txType: "OTHER_CHARGE",
              referenceId: containerId,
              description: `${insertedCharge.description} on container ${container.containerNumber}`,
              referenceTable: "factory_containers",
              currencyCode: insertedCharge.currencyCode || currencyCode,
              amountCurrency: chargeAmount,
              fxRateToUsd: parseFloat(insertedCharge.fxRateToUsd || String(fxRate)),
              metaJson: JSON.stringify({ containerId, sourceType: "OFFLOAD_ADDITIONAL", chargeId: insertedCharge.id }),
            });
          }
        }

        // 7. Delete any creation-time FACTORY-FREIGHT and FACTORY-OC vouchers
        //    before posting new offload ones (prevents double-posting).
        //    Container creation (factoryContainersRoutes.ts) posts a stable, non-suffixed
        //    `FACTORY-FREIGHT-{id}` voucher number when freight is set at creation time —
        //    match that exact form too, not just the `-{timestamp}` suffixed offload form,
        //    or the creation-time voucher survives and freight gets expensed twice.
        //    Likewise, the other-charges sync endpoint posts `FACTORY-OC-{id}-{chargeId}-{ts}`
        //    vouchers while the container is in PENDING state; these must also be cleared
        //    so the offload doesn't double-count them alongside its own OC vouchers.
        const existingPreOffloadVouchers = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.sourceModule, "FACTORY"),
              or(
                eq(vouchers.voucherNumber, `FACTORY-FREIGHT-${containerId}`),
                ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${containerId}-%`),
                ilike(vouchers.voucherNumber, `FACTORY-OC-${containerId}-%`)
              )
            )
          );
        if (existingPreOffloadVouchers.length > 0) {
          const vIds = existingPreOffloadVouchers.map((v) => v.id);
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, vIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, vIds));
        }
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "FREIGHT"),
              eq(factoryDaybookEntries.referenceId, containerId)
            )
          );

        // 8. Freight voucher (double-entry)
        if (freightVal > 0 && (reqFreightAccountId || effectiveFreightSupplierId)) {
          const freightVoucherNum = `FACTORY-FREIGHT-${containerId}-${Date.now()}`;
          const freightVoucherCcy = reqFreightCurrencyCode || currencyCode;
          const freightFx = parseFloat(reqFreightFxRate || String(fxRate));
          const [freightVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: freightVoucherNum,
              voucherDate: offloadDate,
              description: `Freight on container ${container.containerNumber}`,
              totalAmount: String(freightVal),
              currency: freightVoucherCcy,
              exchangeRate: String(freightFx),
              sourceModule: "FACTORY",
            })
            .returning();
          if (effectiveFreightSupplierId) {
            // Supplier: Dr Freight Expense / Cr Supplier Balance
            await tx.insert(voucherEntries).values({
              voucherId: freightVoucher.id,
              ledgerAccountId: freightExpenseAcctId!,
              debitAmount: String(freightVal),
              creditAmount: "0",
              narration: `Freight expense - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: freightVoucher.id,
              factorySupplierId: effectiveFreightSupplierId,
              debitAmount: "0",
              creditAmount: String(freightVal),
              narration: `Freight payable to supplier - container ${container.containerNumber}`,
            });
          } else {
            // Own-account freight: Dr Freight Expense / Cr own account (the account
            // that physically paid the freight, e.g. Embassy Shipping).
            // reqFreightAccountId here is the credit/own account (set from
            // container.freightOwnAccountId by the offload dialog).
            // Both legs are plain ledger accounts — amounts are stored in USD
            // (freightUsd) so GL readers that assume USD are always correct.
            await tx.insert(voucherEntries).values({
              voucherId: freightVoucher.id,
              ledgerAccountId: freightExpenseAcctId!,
              debitAmount: String(freightUsd),
              creditAmount: "0",
              narration: `Freight expense - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: freightVoucher.id,
              ledgerAccountId: parseInt(reqFreightAccountId),
              debitAmount: "0",
              creditAmount: String(freightUsd),
              narration: `Freight paid via own account - container ${container.containerNumber}`,
            });
          }
        }

        // 9. Other Charges voucher (double-entry)
        if (otherChargesVal > 0 && (reqOtherChargesAccountId || reqOtherChargesSupplierId)) {
          const ocMainVoucherNum = `FACTORY-OC-${containerId}-MAIN-${Date.now()}`;
          const ocVoucherCcy = reqOtherChargesCurrencyCode || currencyCode;
          const ocFx = parseFloat(reqOtherChargesFxRate || String(fxRate));
          const [ocMainVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: ocMainVoucherNum,
              voucherDate: offloadDate,
              description: `Other charges on container ${container.containerNumber}`,
              totalAmount: String(otherChargesVal),
              currency: ocVoucherCcy,
              exchangeRate: String(ocFx),
              sourceModule: "FACTORY",
            })
            .returning();
          if (reqOtherChargesSupplierId) {
            // Supplier: Dr OC Expense / Cr Supplier Balance
            await tx.insert(voucherEntries).values({
              voucherId: ocMainVoucher.id,
              ledgerAccountId: ocExpenseAcctId!,
              debitAmount: String(otherChargesVal),
              creditAmount: "0",
              narration: `Other charges expense - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: ocMainVoucher.id,
              factorySupplierId: parseInt(reqOtherChargesSupplierId),
              debitAmount: "0",
              creditAmount: String(otherChargesVal),
              narration: `Other charges payable to supplier - container ${container.containerNumber}`,
            });
          } else {
            // Own-account other charges: Dr OC Expense / Cr chosen account.
            // Both legs are plain ledger accounts so amounts must be in USD (ocUsd)
            // — same reasoning as the freight branch above.
            await tx.insert(voucherEntries).values({
              voucherId: ocMainVoucher.id,
              ledgerAccountId: ocExpenseAcctId!,
              debitAmount: String(ocUsd),
              creditAmount: "0",
              narration: `Other charges expense - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: ocMainVoucher.id,
              ledgerAccountId: parseInt(reqOtherChargesAccountId),
              debitAmount: "0",
              creditAmount: String(ocUsd),
              narration: `Other charges paid via own account - container ${container.containerNumber}`,
            });
          }
        }

        // 10. Additional charges vouchers (double-entry, Dr Factory Charges Payable / Cr chosen)
        for (const inserted of insertedAdditionalCharges) {
          const chargeAmount = parseFloat(inserted.amount || "0");
          if (chargeAmount <= 0) continue;
          if (!inserted.ledgerAccountId && !inserted.supplierId) continue;
          const addlChargeCcy = inserted.currencyCode || currencyCode;
          const addlChargeFxNum = parseFloat(inserted.fxRateToUsd || String(fxRate));
          const addlChargeFx = String(addlChargeFxNum);
          const addlChargeUsd = addlChargeCcy === "USD" ? chargeAmount : chargeAmount * addlChargeFxNum;
          const ocVoucherNum = `FACTORY-OC-${containerId}-${inserted.id}-${Date.now()}`;
          const [ocVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: ocVoucherNum,
              voucherDate: offloadDate,
              description: `${inserted.description} - container ${container.containerNumber}`,
              totalAmount: String(chargeAmount),
              currency: addlChargeCcy,
              exchangeRate: addlChargeFx,
              sourceModule: "FACTORY",
            })
            .returning();
          if (inserted.ledgerAccountId) {
            // Both legs are plain ledger accounts (no factorySupplierId) — post in
            // USD (addlChargeUsd), not the raw native-currency chargeAmount, for the
            // same reason as the freight/other-charges branches above: nothing
            // downstream converts a bare ledgerAccountId leg, so a non-USD amount
            // here silently misstates Net Position and every other USD-summed report.
            await tx.insert(voucherEntries).values({
              voucherId: ocVoucher.id,
              ledgerAccountId: chargesPayableAcctId,
              debitAmount: String(addlChargeUsd),
              creditAmount: "0",
              narration: `${inserted.description} payable - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: ocVoucher.id,
              ledgerAccountId: inserted.ledgerAccountId,
              debitAmount: "0",
              creditAmount: String(addlChargeUsd),
              narration: `${inserted.description} - container ${container.containerNumber}`,
            });
          } else if (inserted.supplierId) {
            // Supplier-linked leg: keep native currency. Supplier balance routes
            // re-derive USD downstream from vouchers.currency/exchangeRate, so both
            // legs of this voucher stay in the charge's own currency.
            await tx.insert(voucherEntries).values({
              voucherId: ocVoucher.id,
              ledgerAccountId: chargesPayableAcctId,
              debitAmount: String(chargeAmount),
              creditAmount: "0",
              narration: `${inserted.description} payable - container ${container.containerNumber}`,
            });
            await tx.insert(voucherEntries).values({
              voucherId: ocVoucher.id,
              factorySupplierId: inserted.supplierId,
              debitAmount: "0",
              creditAmount: String(chargeAmount),
              narration: `${inserted.description} - container ${container.containerNumber}`,
            });
          }
        }

        // (First-receipt event was recorded at step 3 above, inside this same transaction.)
      }); // ── end transaction ────────────────────────────────────────────────────

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "offload",
        tableName: "production_raw_stock",
        recordId: containerId,
        recordIdentifier: `Container #${containerId} — ${receivedKg} kg`,
        changes: null,
      });
      res.json({ rawStock, commission: commissionRecord });
    } catch (error: unknown) {
      logger.error("Error offloading container:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── Reverse Offload ──────────────────────────────────────────────────────────
  registerRawStockReverseOffloadRoute(app);
}
