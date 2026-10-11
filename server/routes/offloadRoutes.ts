/**
 * Container-offload routes.
 *
 * Offload daybook listing/detail, offload optional-toggle, container
 * offload-diagnostics, and the post-offload voucher backfill/repair admin
 * endpoints. Extracted from debugRoutes.ts as a sub-registrar.
 *
 * The optional-toggle effect set lives in
 * services/containers/offloadOptionalToggle.ts so the state guard and the row
 * locks are transaction-owned; this file only resolves the caller identity and
 * maps the outcome onto a response.
 */
import type { Express } from "express";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, and, or, desc, gte, lte, like, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { getOrCreateLedgerAccount } from "./factory/_helpers";
import { parseMoneyInput, sumMoney, toMoney } from "../lib/money";
import { assertActiveCompanyAccess, sendCompanyAccessError } from "../security/companyAccessBoundary";
import {
  containerCharges,
  containerOffloadItems,
  containerOffloads,
  containers,
  ledgerAccounts,
  locations,
  purchaseOrders,
  stockItems,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { resultRows } from "../lib/queryResult";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveOptionalFinancialOperationKey,
} from "../services/accounting/financialOperationRequest";
import {
  DurableFinancialOperationError,
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../services/accounting/durableFinancialOperation";
import {
  applyOffloadOptionalToggleTx,
  OffloadOptionalToggleError,
  type OffloadOptionalToggleOutcome,
} from "../services/containers/offloadOptionalToggle";
import {
  findContainerChargeVoucherDriftTx,
  repairContainerChargeVoucherDriftTx,
} from "../services/containers/offload-lifecycle/charge-voucher-repair";
import { normFactoryEntry } from "../services/factory/factoryVoucherEntryAmounts";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../services/factory/factoryDocumentFxRate";

/**
 * The state the caller asked for, when it stated one.
 *
 * The suspend/restore button knows which direction it means, and saying so is
 * what lets a retransmission be recognized as a replay instead of being served
 * as a second toggle in the opposite direction. Legacy callers send no body and
 * keep the pure toggle behaviour.
 */
function requestedOptionalState(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).optional;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function registerOffloadRoutes(app: Express) {
  // Offloads whose DUTY/OFFICE/TRANS/XFER vouchers were edited before voucher
  // edits re-priced the bales: preview the mismatch, then apply it.
  app.get(
    "/api/admin/offload-charge-voucher-repair",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const drift = await db.transaction((tx) => findContainerChargeVoucherDriftTx(tx, access.activeCompanyId));
        res.json({ drift });
      } catch (error: unknown) {
        logger.error("Offload charge voucher repair preview failed", { error: getErrorMessage(error) });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/offload-charge-voucher-repair",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const rawIds: unknown = req.body?.offloadIds;
        const offloadIds = Array.isArray(rawIds)
          ? rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
          : undefined;
        const result = await db.transaction((tx) =>
          repairContainerChargeVoucherDriftTx(tx, access.activeCompanyId, offloadIds)
        );
        logger.info("Offload charge voucher repair applied", {
          module: "containers",
          action: "offload-charge-voucher-repair",
          companyId: access.activeCompanyId,
          userId: req.session.userId,
          repaired: result.repaired.map((row) => ({
            offloadId: row.offloadId,
            containerNumber: row.containerNumber,
            prefix: row.prefix,
            chargeDelta: row.chargeDelta,
          })),
        });
        res.json(result);
      } catch (error: unknown) {
        logger.error("Offload charge voucher repair failed", { error: getErrorMessage(error) });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // List offloads for daybook view (filtered by date range and company)
  app.get("/api/offloads", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const companyId = access.activeCompanyId;

      const { startDate, endDate } = req.query;
      const conditions = [eq(containers.companyId, companyId)];

      if (startDate) {
        conditions.push(gte(containerOffloads.offloadedAt, new Date((startDate as string) + "T00:00:00")));
      }
      if (endDate) {
        conditions.push(lte(containerOffloads.offloadedAt, new Date((endDate as string) + "T23:59:59")));
      }

      const offloads = await db
        .select({
          id: containerOffloads.id,
          containerId: containerOffloads.containerId,
          containerNumber: containers.containerNumber,
          locationId: containerOffloads.locationId,
          locationName: locations.name,
          duties: containerOffloads.duties,
          officeCharges: containerOffloads.officeCharges,
          transferCharges: containerOffloads.transferCharges,
          transportFees: containerOffloads.transportFees,
          totalCharges: containerOffloads.totalCharges,
          totalBales: containerOffloads.totalBales,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
          offloadedAt: containerOffloads.offloadedAt,
          itemsTotal: sql<string>`coalesce((select sum(coi.total_value) from container_offload_items coi where coi.offload_id = ${containerOffloads.id}), 0)`,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .leftJoin(locations, eq(containerOffloads.locationId, locations.id))
        .where(and(...conditions))
        .orderBy(desc(containerOffloads.offloadedAt))
        .execute();

      res.json(offloads);
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Get full offload detail with items for daybook view
  app.get("/api/offloads/:id", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const offloadId = parseInt(req.params.id);
      if (isNaN(offloadId)) return res.status(400).json({ message: "Invalid offload ID" });

      const [offload] = await db
        .select({
          id: containerOffloads.id,
          containerId: containerOffloads.containerId,
          containerNumber: containers.containerNumber,
          locationId: containerOffloads.locationId,
          locationName: locations.name,
          duties: containerOffloads.duties,
          officeCharges: containerOffloads.officeCharges,
          transferCharges: containerOffloads.transferCharges,
          transportFees: containerOffloads.transportFees,
          totalCharges: containerOffloads.totalCharges,
          totalBales: containerOffloads.totalBales,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
          offloadedAt: containerOffloads.offloadedAt,
          containerChargesTotal: containers.chargesTotal,
          optional: containerOffloads.optional,
          companyId: containers.companyId,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .leftJoin(locations, eq(containerOffloads.locationId, locations.id))
        .where(eq(containerOffloads.id, offloadId))
        .execute();

      if (!offload) return res.status(404).json({ message: "Offload not found" });
      if (offload.companyId !== access.activeCompanyId) {
        return res.status(403).json({ message: "No access to this company", code: "COMPANY_ACCESS_DENIED" });
      }

      const items = await db
        .select({
          id: containerOffloadItems.id,
          stockItemId: containerOffloadItems.stockItemId,
          stockItemName: stockItems.name,
          stockItemCode: stockItems.code,
          quantity: containerOffloadItems.quantity,
          rate: containerOffloadItems.rate,
          totalValue: containerOffloadItems.totalValue,
        })
        .from(containerOffloadItems)
        .leftJoin(stockItems, eq(containerOffloadItems.stockItemId, stockItems.id))
        .where(eq(containerOffloadItems.offloadId, offloadId))
        .execute();

      // Fetch PO-level charges for the container (freight, fumigation, surcharge, documentCharges, discount, otherCharges)
      const pos = await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          freight: purchaseOrders.freight,
          surcharge: purchaseOrders.surcharge,
          fumigation: purchaseOrders.fumigation,
          documentCharges: purchaseOrders.documentCharges,
          discount: purchaseOrders.discount,
          otherCharges: purchaseOrders.otherCharges,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.containerId, offload.containerId))
        .execute();

      // Aggregate PO charges for display
      const poFreight = sumMoney(pos.map((p) => p.freight)).toNumber();
      const poSurcharge = sumMoney(pos.map((p) => p.surcharge)).toNumber();
      const poFumigation = sumMoney(pos.map((p) => p.fumigation)).toNumber();
      const poDocumentCharges = sumMoney(pos.map((p) => p.documentCharges)).toNumber();
      const poDiscount = sumMoney(pos.map((p) => p.discount)).toNumber();
      const poOtherCharges = sumMoney(pos.map((p) => p.otherCharges)).toNumber();

      // Fetch additional charges (fumigation, misc charges attached to the container)
      const additionalCharges = await db
        .select({
          id: containerCharges.id,
          chargeType: containerCharges.chargeType,
          amount: containerCharges.amount,
        })
        .from(containerCharges)
        .where(eq(containerCharges.containerId, offload.containerId))
        .execute();

      const poCharges = {
        freight: poFreight,
        surcharge: poSurcharge,
        fumigation: poFumigation,
        documentCharges: poDocumentCharges,
        discount: poDiscount,
        otherCharges: poOtherCharges,
        total: toMoney(offload.containerChargesTotal).toNumber(),
      };

      // Fetch LIVE voucher totals for this container so external edits are reflected immediately
      // Pattern: DUTY-{containerNumber}-*, OFFICE-{containerNumber}-*, TRANS-{containerNumber}-*, XFER-{containerNumber}-*, CHG-{containerNumber}-*
      const cn = offload.containerNumber;
      const liveVouchers = await db
        .select({ voucherNumber: vouchers.voucherNumber, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, offload.companyId),
            or(
              like(vouchers.voucherNumber, `DUTY-${cn}-%`),
              like(vouchers.voucherNumber, `OFFICE-${cn}-%`),
              like(vouchers.voucherNumber, `TRANS-${cn}-%`),
              like(vouchers.voucherNumber, `XFER-${cn}-%`),
              like(vouchers.voucherNumber, `CHG-${cn}-%`)
            )
          )
        )
        .execute();

      const sumByPrefix = (prefix: string) =>
        sumMoney(liveVouchers.filter((v) => v.voucherNumber.startsWith(`${prefix}-${cn}-`)).map((v) => v.totalAmount));

      const liveDuties = sumByPrefix("DUTY");
      const liveOfficeCharges = sumByPrefix("OFFICE");
      const liveTransportFees = sumByPrefix("TRANS");
      const liveTransferCharges = sumByPrefix("XFER");
      const liveAddlCharges = sumByPrefix("CHG");

      const liveTotalOffloadCharges = sumMoney([
        liveDuties,
        liveOfficeCharges,
        liveTransportFees,
        liveTransferCharges,
        liveAddlCharges,
      ]);
      const liveTotalAllCharges = liveTotalOffloadCharges.plus(toMoney(offload.containerChargesTotal));
      const totalBales = toMoney(offload.totalBales);
      // Exact, then rounded half up to cents; the float division could land a
      // half cent below its true value and round down.
      const liveAdditionalCostPerBale = totalBales.greaterThan(0)
        ? liveTotalAllCharges.dividedBy(totalBales).toDecimalPlaces(2).toNumber()
        : 0;

      const liveCharges = {
        duties: liveDuties.toNumber(),
        officeCharges: liveOfficeCharges.toNumber(),
        transportFees: liveTransportFees.toNumber(),
        transferCharges: liveTransferCharges.toNumber(),
        additionalCharges: liveAddlCharges.toNumber(),
        totalOffloadCharges: liveTotalOffloadCharges.toNumber(),
        totalAllCharges: liveTotalAllCharges.toNumber(),
        additionalCostPerBale: liveAdditionalCostPerBale,
        hasVouchers: liveVouchers.length > 0,
      };

      res.json({ ...offload, items, poCharges, additionalCharges, liveCharges });
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Toggle offload optional status — suspends/unsuspends inventory + vouchers without reversing permanently.
  //
  // The effect set lives in applyOffloadOptionalToggleTx so the target state, the
  // row locks, and the replay decision are one transaction-owned unit: a retry or
  // a second simultaneous request cannot remove or restore the offloaded stock a
  // second time. A caller that supplies X-Idempotency-Key/clientRequestId also
  // gets the durable financial-operation replay, so an identical retransmission
  // returns the recorded outcome instead of running again.
  app.post(
    "/api/offloads/:id/toggle-optional",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const offloadId = parseInt(req.params.id);
        if (isNaN(offloadId)) return res.status(400).json({ message: "Invalid offload ID" });

        const requestId = resolveOptionalFinancialOperationKey(req);
        const toggleInput = {
          companyId: access.activeCompanyId,
          offloadId,
          requestedOptional: requestedOptionalState(req.body),
          requestId,
          actorUserId: req.session.userId ?? null,
          actorUsername: req.session.username ?? null,
        };

        if (requestId) {
          const operation = await withDurableFinancialOperation<OffloadOptionalToggleOutcome>(
            {
              companyId: Number(access.activeCompanyId),
              operationName: "container.offload-optional-toggle",
              idempotencyKey: requestId,
              requestFingerprint: financialOperationFingerprint({
                method: req.method,
                path: req.path,
                companyId: Number(access.activeCompanyId),
                body: financialOperationRequestPayload(req.body),
              }),
            },
            async (tx) => ({ value: await applyOffloadOptionalToggleTx(tx, toggleInput) })
          );
          return res.json({
            optional: operation.value.optional,
            replayed: operation.replayed || operation.value.replayed,
            message: operation.value.message,
          });
        }

        const outcome = await db.transaction(async (tx) => applyOffloadOptionalToggleTx(tx, toggleInput));
        res.json({ optional: outcome.optional, replayed: outcome.replayed, message: outcome.message });
      } catch (error: unknown) {
        if (error instanceof OffloadOptionalToggleError) {
          return res.status(error.status).json({ message: error.message, code: error.code });
        }
        if (error instanceof DurableFinancialOperationError) {
          return res.status(financialOperationErrorStatus(error)).json({ message: error.message, code: error.code });
        }
        logger.error("Error toggling offload optional:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // Container Offload Diagnostics - Analyze PO line items for potential issues
  app.get(
    "/api/containers/:id/offload-diagnostics",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const containerId = parseInt(req.params.id);
        if (isNaN(containerId)) {
          return res.status(400).json({ message: "Invalid container ID" });
        }

        const access = await assertActiveCompanyAccess(req);
        const companyId = access.activeCompanyId;

        // Get container
        const container = await storage.getContainerById(containerId);
        if (!container || container.companyId !== companyId) {
          return res.status(404).json({ message: "Container not found" });
        }

        // Get all POs for this container
        const pos = await storage.getPurchaseOrdersByContainer(containerId);

        const lineItemDetails: Array<{
          poId: number;
          poNumber: string;
          lineItemId: number;
          stockItemId: number | null;
          stockItemCode: string | null;
          stockItemName: string | null;
          quantity: string;
          quantityParsed: number;
          rate: string;
          isValid: boolean;
          issues: string[];
        }> = [];

        const duplicateCheck = new Map<string, number[]>(); // stockItemId -> [lineItemIds]
        let totalQuantity = 0;
        let invalidLineItems = 0;
        let blankQuantities = 0;

        for (const po of pos) {
          const lineItems = await storage.getLineItemsByPO(po.id);

          for (const item of lineItems) {
            const issues: string[] = [];
            const quantityParsed = parseMoneyInput(item.quantity)?.toNumber() ?? NaN;

            // Check for issues
            if (!item.stockItemId || item.stockItemId === 0) {
              issues.push("No stock item assigned");
              invalidLineItems++;
            }

            if (isNaN(quantityParsed) || item.quantity === "" || item.quantity === null) {
              issues.push("Blank or invalid quantity");
              blankQuantities++;
            } else if (quantityParsed <= 0) {
              issues.push("Zero or negative quantity");
            } else {
              totalQuantity += quantityParsed;
            }

            // Track for duplicate detection
            if (item.stockItemId && item.stockItemId !== 0) {
              const key = `${po.id}-${item.stockItemId}`;
              if (!duplicateCheck.has(key)) {
                duplicateCheck.set(key, []);
              }
              duplicateCheck.get(key)!.push(item.id);
            }

            // Get stock item details
            let stockItemCode: string | null = null;
            let stockItemName: string | null = null;
            if (item.stockItemId) {
              const stockItem = await storage.getStockItemById(item.stockItemId);
              if (stockItem) {
                stockItemCode = stockItem.code;
                stockItemName = stockItem.name;
              }
            }

            lineItemDetails.push({
              poId: po.id,
              poNumber: po.poNumber || `PO-${po.id}`,
              lineItemId: item.id,
              stockItemId: item.stockItemId,
              stockItemCode,
              stockItemName,
              quantity: item.quantity,
              quantityParsed: isNaN(quantityParsed) ? 0 : quantityParsed,
              rate: item.rate,
              isValid: issues.length === 0,
              issues,
            });
          }
        }

        // Check for duplicates
        const duplicates: Array<{ stockItemId: number; poId: number; lineItemIds: number[] }> = [];
        for (const [key, lineItemIds] of Array.from(duplicateCheck.entries())) {
          if (lineItemIds.length > 1) {
            const [poId, stockItemId] = key.split("-").map(Number);
            duplicates.push({ stockItemId, poId, lineItemIds });

            // Mark duplicates in lineItemDetails
            for (const detail of lineItemDetails) {
              if (lineItemIds.includes(detail.lineItemId)) {
                detail.issues.push(`Duplicate: ${lineItemIds.length} entries for same stock item in same PO`);
                detail.isValid = false;
              }
            }
          }
        }

        // Check existing inventory for pre-sales
        const inventoryWarnings: Array<{
          stockItemId: number;
          stockItemCode: string;
          currentQty: number;
          incomingQty: number;
          resultQty: number;
        }> = [];

        // Group by stock item
        const stockItemTotals = new Map<number, number>();
        for (const item of lineItemDetails) {
          if (item.stockItemId && item.isValid) {
            stockItemTotals.set(item.stockItemId, (stockItemTotals.get(item.stockItemId) || 0) + item.quantityParsed);
          }
        }

        res.json({
          containerId,
          containerNumber: container.containerNumber,
          containerStatus: container.status,
          poCount: pos.length,
          lineItemCount: lineItemDetails.length,
          totalQuantity,
          invalidLineItems,
          blankQuantities,
          duplicateCount: duplicates.length,
          duplicates,
          lineItems: lineItemDetails,
          inventoryWarnings,
          hasIssues: invalidLineItems > 0 || blankQuantities > 0 || duplicates.length > 0,
          summary: {
            valid: lineItemDetails.filter((i) => i.isValid).length,
            invalid: lineItemDetails.filter((i) => !i.isValid).length,
          },
        });
      } catch (error: unknown) {
        logger.error("Container offload diagnostics error:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // Get all containers for diagnostics selection
  app.get("/api/admin/containers-for-diagnostics", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const allContainers = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          status: containers.status,
          itemsTotal: containers.itemsTotal,
        })
        .from(containers)
        .where(eq(containers.companyId, companyId))
        .orderBy(desc(containers.id));

      res.json(allContainers);
    } catch (error: unknown) {
      logger.error("Get containers for diagnostics error:", { error: error });
      return sendCompanyAccessError(res, error);
    }
  });

  // Net Profit (P&L) Report - Tally Prime style

  // Backfill missing vouchers for post-offload charges that already have a ledgerAccountId
  // but whose voucher was created in the wrong company (factory instead of ledger account's company).
  // Idempotent: skips any charge that already has a voucher crediting the chosen ledger account.
  app.post(
    "/api/admin/backfill-postoffload-vouchers",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req, res) => {
      try {
        let scanned = 0,
          created = 0,
          skippedExisting = 0,
          errors = 0,
          refusedNoRate = 0;
        const errorDetails: string[] = [];

        // Fetch all post-offload charges that have a ledger account chosen
        const chargesRes = await db.execute(sql`
        SELECT
          c.id,
          c.container_id,
          c.description,
          c.amount,
          c.currency_code,
          c.fx_rate_to_usd,
          c.fx_rate_confirmed,
          c.ledger_account_id,
          c.created_at,
          fc.container_number
        FROM factory_offload_additional_charges c
        JOIN factory_containers fc ON fc.id = c.container_id
        WHERE c.ledger_account_id IS NOT NULL
        ORDER BY c.id
      `);
        type OffloadChargeRow = {
          id: number;
          container_id: number;
          description: string | null;
          amount: string | null;
          currency_code: string | null;
          fx_rate_to_usd: string | null;
          fx_rate_confirmed: boolean | null;
          ledger_account_id: number;
          created_at: Date | string | null;
          container_number: string;
        };
        const rows = resultRows<OffloadChargeRow>(chargesRes);

        for (const row of rows) {
          scanned++;
          try {
            const chargeId: number = row.id;
            const containerId: number = row.container_id;
            const containerNumber: string = row.container_number || `#${containerId}`;
            const ledgerAccountId: number = row.ledger_account_id;
            const description: string = row.description || "Post-offload charge";
            const amount = toMoney(row.amount);
            const chargeCcy: string = row.currency_code || "USD";
            const voucherDate: string = row.created_at
              ? new Date(row.created_at).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);

            if (amount.lessThanOrEqualTo(0)) {
              skippedExisting++;
              continue;
            }

            // Resolve the ledger account's company
            const [acctRow] = await db
              .select({ companyId: ledgerAccounts.companyId })
              .from(ledgerAccounts)
              .where(eq(ledgerAccounts.id, ledgerAccountId));
            if (!acctRow) {
              errors++;
              errorDetails.push(`chargeId=${chargeId}: ledgerAccount ${ledgerAccountId} not found`);
              continue;
            }
            const voucherCompanyId = acctRow.companyId;

            // Idempotency: check if a voucher already exists that credits this ledger account
            // for a post-offload entry on this container
            const existingCheck = await db.execute(sql`
            SELECT v.id
            FROM vouchers v
            JOIN voucher_entries ve ON ve.voucher_id = v.id
            WHERE v.source_module = 'FACTORY'
              AND v.company_id = ${voucherCompanyId}
              AND v.description ILIKE ${"%(post-offload)%container " + containerNumber + "%"}
              AND ve.ledger_account_id = ${ledgerAccountId}
              AND ve.credit_amount::numeric > 0
            LIMIT 1
          `);
            const existingRows = resultRows(existingCheck);
            if (existingRows.length > 0) {
              skippedExisting++;
              continue;
            }

            // Wave 17 (D): a non-USD charge is posted normalized at its own confirmed
            // rate, else at the factory's confirmed rate on or before the voucher
            // date; with no such rate it is refused (listed, nothing posted). It
            // used to be posted in the legacy shape.
            let chargeFx: string;
            try {
              chargeFx = (
                await factoryDocumentRate(db, voucherCompanyId, chargeCcy, voucherDate, {
                  rate: row.fx_rate_to_usd,
                  confirmed: row.fx_rate_confirmed,
                })
              ).rate;
            } catch (rateError) {
              if (!(rateError instanceof FactoryFxRateRequiredError)) throw rateError;
              refusedNoRate++;
              errorDetails.push(
                `chargeId=${chargeId}: ${rateError.code} (${rateError.currency} on ${rateError.documentDate})`
              );
              continue;
            }

            // Get or create FACTORY_CHARGES_PAYABLE in the ledger account's company
            const cpAcctId = await getOrCreateLedgerAccount(
              voucherCompanyId,
              "FACTORY_CHARGES_PAYABLE",
              "Factory Charges Payable"
            );

            // Insert the voucher
            const voucherNum = `FACTORY-POC-BACKFILL-${containerId}-${chargeId}`;
            const voucher = await db.transaction(async (tx) => {
              const [posted] = await tx
                .insert(vouchers)
                .values({
                  companyId: voucherCompanyId,
                  voucherType: "Journal",
                  voucherNumber: voucherNum,
                  voucherDate,
                  description: `${description} (post-offload) — container ${containerNumber}`,
                  totalAmount: amount.toFixed(),
                  currency: chargeCcy,
                  exchangeRate: chargeFx,
                  sourceModule: "FACTORY",
                })
                .returning();

              // DR FACTORY_CHARGES_PAYABLE
              await tx.insert(voucherEntries).values({
                voucherId: posted.id,
                ledgerAccountId: cpAcctId,
                ...normFactoryEntry(chargeCcy, amount.toFixed(), "0", chargeFx),
                narration: `${description} payable — container ${containerNumber}`,
              });
              // CR chosen ledger account
              await tx.insert(voucherEntries).values({
                voucherId: posted.id,
                ledgerAccountId,
                ...normFactoryEntry(chargeCcy, "0", amount.toFixed(), chargeFx),
                narration: `${description} — container ${containerNumber}`,
              });
              return posted;
            });

            created++;
            logger.info(
              `[POC backfill] voucherId=${voucher.id} chargeId=${chargeId} container=${containerNumber} voucherCompanyId=${voucherCompanyId} cpAcctId=${cpAcctId}`
            );
          } catch (err: unknown) {
            errors++;
            errorDetails.push(`chargeId=${row.id}: ${getErrorMessage(err)}`);
            logger.error(`[POC backfill] error on chargeId=${row.id}:`, { error: err });
          }
        }

        res.json({ scanned, created, skippedExisting, errors, refusedNoRate, errorDetails });
      } catch (error: unknown) {
        logger.error("Backfill post-offload vouchers error:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );
}
