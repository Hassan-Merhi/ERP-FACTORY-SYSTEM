/**
 * Container-offload routes.
 *
 * Offload daybook listing/detail, offload optional-toggle, container
 * offload-diagnostics, and the post-offload voucher backfill/repair admin
 * endpoints. Extracted from debugRoutes.ts as a sub-registrar; behaviour is
 * unchanged.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, and, or, desc, inArray, gte, lte, like, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { adjustInventory, reverseInventoryByExactValue } from "../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { getOrCreateLedgerAccount } from "./factory/_helpers";
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

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerOffloadRoutes(app: Express) {
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
      const poFreight = pos.reduce((s, p) => s + parseFloat(p.freight || "0"), 0);
      const poSurcharge = pos.reduce((s, p) => s + parseFloat(p.surcharge || "0"), 0);
      const poFumigation = pos.reduce((s, p) => s + parseFloat(p.fumigation || "0"), 0);
      const poDocumentCharges = pos.reduce((s, p) => s + parseFloat(p.documentCharges || "0"), 0);
      const poDiscount = pos.reduce((s, p) => s + parseFloat(p.discount || "0"), 0);
      const poOtherCharges = pos.reduce((s, p) => s + parseFloat(p.otherCharges || "0"), 0);

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
        total: parseFloat(offload.containerChargesTotal || "0"),
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
        liveVouchers
          .filter((v) => v.voucherNumber.startsWith(`${prefix}-${cn}-`))
          .reduce((s, v) => s + parseFloat(v.totalAmount || "0"), 0);

      const liveDuties = sumByPrefix("DUTY");
      const liveOfficeCharges = sumByPrefix("OFFICE");
      const liveTransportFees = sumByPrefix("TRANS");
      const liveTransferCharges = sumByPrefix("XFER");
      const liveAddlCharges = sumByPrefix("CHG");

      const liveTotalOffloadCharges =
        liveDuties + liveOfficeCharges + liveTransportFees + liveTransferCharges + liveAddlCharges;
      const liveTotalAllCharges = liveTotalOffloadCharges + poCharges.total;
      const totalBalesNum = parseFloat(offload.totalBales || "0");
      const liveAdditionalCostPerBale =
        totalBalesNum > 0 ? Math.round((liveTotalAllCharges / totalBalesNum) * 100) / 100 : 0;

      const liveCharges = {
        duties: liveDuties,
        officeCharges: liveOfficeCharges,
        transportFees: liveTransportFees,
        transferCharges: liveTransferCharges,
        additionalCharges: liveAddlCharges,
        totalOffloadCharges: liveTotalOffloadCharges,
        totalAllCharges: liveTotalAllCharges,
        additionalCostPerBale: liveAdditionalCostPerBale,
        hasVouchers: liveVouchers.length > 0,
      };

      res.json({ ...offload, items, poCharges, additionalCharges, liveCharges });
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Toggle offload optional status — suspends/unsuspends inventory + vouchers without reversing permanently
  app.post(
    "/api/offloads/:id/toggle-optional",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const offloadId = parseInt(req.params.id);
        if (isNaN(offloadId)) return res.status(400).json({ message: "Invalid offload ID" });

        const [offload] = await db
          .select({
            id: containerOffloads.id,
            containerId: containerOffloads.containerId,
            locationId: containerOffloads.locationId,
            optional: containerOffloads.optional,
            offloadedAt: containerOffloads.offloadedAt,
            companyId: containers.companyId,
            containerNumber: containers.containerNumber,
          })
          .from(containerOffloads)
          .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
          .where(eq(containerOffloads.id, offloadId))
          .execute();

        if (!offload) return res.status(404).json({ message: "Offload not found" });
        if (offload.companyId !== access.activeCompanyId) {
          return res.status(403).json({ message: "No access to this company", code: "COMPANY_ACCESS_DENIED" });
        }

        const makeOptional = !offload.optional; // toggle
        const cn = offload.containerNumber;
        const operationId = randomUUID();
        const occurredAt = new Date().toISOString();

        // Fetch the exact offload items (quantities + values as-offloaded)
        const offloadItems = await db
          .select()
          .from(containerOffloadItems)
          .where(eq(containerOffloadItems.offloadId, offloadId))
          .execute();

        if (offloadItems.length === 0) {
          return res.status(400).json({ message: "No offload items found — cannot toggle optional status" });
        }

        await db.transaction(async (tx) => {
          // 1. Toggle inventory
          for (const item of offloadItems) {
            const qty = parseFloat(item.quantity);
            const value = parseFloat(item.totalValue);
            const rate = parseFloat(item.rate);

            if (makeOptional) {
              // Suspending: remove the stock that was added at offload
              await reverseInventoryByExactValue(
                tx,
                offload.locationId,
                item.stockItemId,
                qty,
                value,
                offload.companyId
              );
            } else {
              // Unsuspending: add the stock back at the original rate
              await adjustInventory(tx, offload.locationId, item.stockItemId, qty, offload.companyId, rate);
            }

            await postStockMovementTx(
              tx,
              {
                companyId: offload.companyId,
                stockItemId: item.stockItemId,
                kind: "adjustment",
                quantity: String(Math.abs(qty)),
                unitCost: String(Math.max(rate || (qty !== 0 ? value / qty : 0), 0)),
                fromLocationId: makeOptional ? offload.locationId : undefined,
                toLocationId: makeOptional ? undefined : offload.locationId,
                occurredAt,
                source: {
                  sourceType: makeOptional ? "offload_optional_suspend" : "offload_optional_restore",
                  sourceId: String(offloadId),
                  idempotencyKey: `offload-optional:${offload.companyId}:${offloadId}:${operationId}:${item.id}`,
                },
                actor: {
                  userId: req.session.userId,
                  username: req.session.username,
                  reason: makeOptional ? "Suspend container offload" : "Restore container offload",
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }

          // 2. Toggle all offload-related vouchers (DUTY-, OFFICE-, TRANS-, XFER-, CHG-)
          const offloadVouchers = await tx
            .select({ id: vouchers.id })
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

          if (offloadVouchers.length > 0) {
            const voucherIds = offloadVouchers.map((v) => v.id);
            await tx.update(vouchers).set({ optional: makeOptional }).where(inArray(vouchers.id, voucherIds));
          }

          // 3. Update the offload record itself
          await tx.update(containerOffloads).set({ optional: makeOptional }).where(eq(containerOffloads.id, offloadId));

          // 4. Sync container status to match the new offload state
          if (makeOptional) {
            // Suspending: check if ALL offloads for this container are now optional.
            // If so, revert the container back to OTW so it shows on the tracking page.
            const remainingActive = await tx
              .select({ id: containerOffloads.id })
              .from(containerOffloads)
              .where(
                and(eq(containerOffloads.containerId, offload.containerId), eq(containerOffloads.optional, false))
              );
            if (remainingActive.length === 0) {
              await tx
                .update(containers)
                .set({ status: "OTW", offloadDate: null })
                .where(eq(containers.id, offload.containerId));
            }
          } else {
            // Unsuspending: container must be OFFLOADED again.
            // Restore offloadDate from the offload's offloadedAt timestamp.
            const restoredDate =
              offload.offloadedAt instanceof Date
                ? offload.offloadedAt.toISOString().split("T")[0]
                : new Date().toISOString().split("T")[0];
            await tx
              .update(containers)
              .set({ status: "OFFLOADED", offloadDate: restoredDate })
              .where(eq(containers.id, offload.containerId));
          }
        });

        res.json({
          optional: makeOptional,
          message: makeOptional
            ? "Offload suspended — stock removed, vouchers set to optional, container moved back to OTW."
            : "Offload restored — stock re-added, vouchers made active, container marked OFFLOADED.",
        });
      } catch (error: unknown) {
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
            const quantityParsed = parseFloat(item.quantity);

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
          errors = 0;
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
            const amount = parseFloat(row.amount || "0");
            const chargeCcy: string = row.currency_code || "USD";
            const chargeFx = parseFloat(row.fx_rate_to_usd || "1");
            const voucherDate: string = row.created_at
              ? new Date(row.created_at).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);

            if (amount <= 0) {
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

            // Get or create FACTORY_CHARGES_PAYABLE in the ledger account's company
            const cpAcctId = await getOrCreateLedgerAccount(
              voucherCompanyId,
              "FACTORY_CHARGES_PAYABLE",
              "Factory Charges Payable"
            );

            // Insert the voucher
            const voucherNum = `FACTORY-POC-BACKFILL-${containerId}-${chargeId}`;
            const [voucher] = await db
              .insert(vouchers)
              .values({
                companyId: voucherCompanyId,
                voucherType: "Journal",
                voucherNumber: voucherNum,
                voucherDate,
                description: `${description} (post-offload) — container ${containerNumber}`,
                totalAmount: String(amount),
                currency: chargeCcy,
                exchangeRate: String(chargeFx),
                sourceModule: "FACTORY",
              })
              .returning();

            // DR FACTORY_CHARGES_PAYABLE
            await db.insert(voucherEntries).values({
              voucherId: voucher.id,
              ledgerAccountId: cpAcctId,
              debitAmount: String(amount),
              creditAmount: "0",
              narration: `${description} payable — container ${containerNumber}`,
            });
            // CR chosen ledger account
            await db.insert(voucherEntries).values({
              voucherId: voucher.id,
              ledgerAccountId,
              debitAmount: "0",
              creditAmount: String(amount),
              narration: `${description} — container ${containerNumber}`,
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

        res.json({ scanned, created, skippedExisting, errors, errorDetails });
      } catch (error: unknown) {
        logger.error("Backfill post-offload vouchers error:", { error: error });
        return sendCompanyAccessError(res, error);
      }
    }
  );
}
