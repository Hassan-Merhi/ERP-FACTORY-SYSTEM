/**
 * Bale lookup routes.
 *
 * Article-code and reference-number lookups and the reference-scan flow used
 * by the factory floor. Extracted from baleRoutes.ts as a sub-registrar;
 * behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, or, desc, sql, inArray, ilike, isNull } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { logAudit } from "./_helpers";
import {
  auditLog,
  baleLabelPrints,
  customerOrderBales,
  customerOrders,
  customers,
  factoryBaleProducts,
  factoryBales,
  factoryContainers,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryPressingBatches,
  factorySuppliers,
  factoryWorkers,
  locations,
} from "@shared/schema";

export function registerBaleLookupRoutes(app: Express) {
  // Lookup by ARTICLE code
  app.get("/api/lookup/article/:articleCode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const articleCode = decodeURIComponent(req.params.articleCode);

      // Search for a matching product in BOTH catalogs in parallel
      const [erpProduct, labelPrints, factoryProductRows] = await Promise.all([
        storage.getBaleProductByArticleCode(articleCode, companyId),
        storage.getBaleLabelPrintsByArticle(articleCode, companyId),
        // factoryBales.productId points to factory_bale_products, not bale_products
        // Use case-insensitive match so article codes with mixed case are still found.
        db
          .select({
            id: factoryBaleProducts.id,
            name: factoryBaleProducts.name,
            code: factoryBaleProducts.code,
            articleCode: factoryBaleProducts.articleCode,
            active: factoryBaleProducts.active,
          })
          .from(factoryBaleProducts)
          .where(
            and(eq(factoryBaleProducts.companyId, companyId), ilike(factoryBaleProducts.articleCode, articleCode))
          ),
      ]);

      // Use ERP product for display if found; fall back to factory product
      const factoryProduct = factoryProductRows[0] ?? null;
      const displayProduct =
        erpProduct ||
        (factoryProduct ? { ...factoryProduct, weightPerBaleKg: null, description: null, categoryId: null } : null);

      // IDs in factory_bale_products that match this article code
      const factoryProductIds = factoryProductRows.map((p) => p.id);

      // Enrich each label print with bale status so non-admin users can see deleted bales
      const refNumbers = labelPrints.map((lp) => lp.referenceNumber).filter(Boolean);
      const coveredRefs = new Set(refNumbers);
      const baleStatusMap: Record<string, string> = {};
      if (refNumbers.length > 0) {
        const baleRows = await db
          .select({ referenceNumber: factoryBales.referenceNumber, status: factoryBales.status })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.referenceNumber, refNumbers)));
        for (const b of baleRows) {
          if (b.referenceNumber) baleStatusMap[b.referenceNumber] = b.status;
        }
      }

      const enrichedLabelPrints = labelPrints.map((lp) => ({
        ...lp,
        baleStatus: baleStatusMap[lp.referenceNumber] ?? null,
      }));

      // Also find bales in factory_bales that have this articleCode (directly on the bale row,
      // or via productId → factory_bale_products) but have NO label print entry yet.
      // These are manually imported bales, system-created bales, or produced bales never printed.
      let directBalesWhereClause;
      if (factoryProductIds.length > 0) {
        directBalesWhereClause = and(
          eq(factoryBales.companyId, companyId),
          or(
            sql`LOWER(${factoryBales.articleCode}) = LOWER(${articleCode})`,
            inArray(factoryBales.productId, factoryProductIds)
          )
        );
      } else {
        directBalesWhereClause = and(
          eq(factoryBales.companyId, companyId),
          sql`LOWER(${factoryBales.articleCode}) = LOWER(${articleCode})`
        );
      }

      const directBalesRaw = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          weightKg: factoryBales.weightKg,
          status: factoryBales.status,
          createdAt: factoryBales.createdAt,
        })
        .from(factoryBales)
        .where(directBalesWhereClause);

      // Only include bales not already covered by a label print
      const uncoveredBales = directBalesRaw.filter((b) => b.referenceNumber && !coveredRefs.has(b.referenceNumber));

      // Synthesize label-print-like entries (negative ID to avoid collision with real print IDs)
      const syntheticEntries = uncoveredBales.map((b) => ({
        id: -b.id,
        referenceNumber: b.referenceNumber,
        approxWeightKg: b.weightKg,
        articleCode,
        companyId,
        printedAt: null,
        scannedAt: null,
        scannedByUserId: null,
        scannedByName: null,
        baleStatus: b.status,
        _synthetic: true,
      }));

      // Merge: real label prints first, then synthetic entries sorted by reference number
      const allEntries = [
        ...enrichedLabelPrints,
        ...syntheticEntries.sort((a, b) => a.referenceNumber.localeCompare(b.referenceNumber)),
      ];

      res.json({ product: displayProduct || null, labelPrints: allEntries });
    } catch (error: unknown) {
      logger.error("Error looking up article:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Lookup by REFERENCE number
  app.get("/api/lookup/reference/:referenceNumber", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
      const labelPrint = await storage.getBaleLabelPrintByReference(referenceNumber, companyId);

      // If no label print exists, try to find the bale directly in factory_bales
      // (bales can exist without a label print if entered manually / imported)
      // Use normalized comparison for legacy lowercase/whitespace references, but
      // reject ambiguous normalized duplicates rather than returning an arbitrary bale.
      if (!labelPrint) {
        const directBaleMatches = await db
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`
            )
          )
          .limit(2);

        if (directBaleMatches.length === 0) {
          return res.status(404).json({ message: "Reference number not found" });
        }
        if (directBaleMatches.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }
        const directBale = directBaleMatches[0];

        // Build a minimal response from the bale row alone
        let locationInfo = null;
        if (directBale.erpLocationId) {
          const [loc] = await db
            .select({ id: locations.id, name: locations.name, city: locations.city, state: locations.state })
            .from(locations)
            .where(eq(locations.id, directBale.erpLocationId))
            .limit(1);
          if (loc) locationInfo = loc;
        }

        let product = null;
        if (directBale.productId) {
          product = await storage.getBaleProductById(directBale.productId);
        } else if (directBale.articleCode) {
          product = await storage.getBaleProductByArticleCode(directBale.articleCode, companyId);
        }

        // Use stored workerName first (denormalized); fall back to join if not yet populated
        let directWorkerName: string | null = directBale.workerName ?? null;
        if (!directWorkerName && directBale.finalizedBy) {
          const [wk] = await db
            .select({ fullName: factoryWorkers.fullName })
            .from(factoryWorkers)
            .where(eq(factoryWorkers.id, directBale.finalizedBy))
            .limit(1);
          if (wk) directWorkerName = wk.fullName;
        }

        // Check if this bale is in a non-deleted outbound order.
        // Soft-deleted orders are historical records only and must not make a bale look loaded.
        const [directOrderBale] = await db
          .select({ orderId: customerOrderBales.orderId, status: customerOrders.status })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(
            and(
              sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`,
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          )
          .limit(1);
        let directLoadedOnOrder = null;
        let directIsInLoadingOrder = false;
        if (directOrderBale) {
          if (directOrderBale.status === "LOADING") directIsInLoadingOrder = true;
          directLoadedOnOrder = { status: directOrderBale.status };
        }

        // If the bale's stored status is IN_STOCK but it's already on a finalized order,
        // derive the correct effective status so the Bale Explorer shows it accurately.
        const _finalizedStatuses = ["FINALIZED", "DISPATCHED", "SOLD"];
        const directEffectiveStatus =
          directBale.status === "IN_STOCK" &&
          directLoadedOnOrder?.status &&
          _finalizedStatuses.includes(directLoadedOnOrder.status)
            ? "SOLD"
            : directBale.status;

        // Fetch audit history for this bale
        const directAuditHistory = await db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            username: auditLog.username,
            changes: auditLog.changes,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(and(eq(auditLog.tableName, "factory_bales"), eq(auditLog.recordId, directBale.id)))
          .orderBy(desc(auditLog.createdAt))
          .limit(30);

        return res.json({
          labelPrint: null,
          product: product || null,
          baleInfo: {
            id: directBale.id,
            baleCode: directBale.baleCode,
            articleCode: product?.articleCode || directBale.articleCode || null,
            productName: directBale.productName,
            status: directEffectiveStatus,
            isInLoadingOrder: directIsInLoadingOrder,
            weightKg: directBale.weightKg,
            costPerKg: directBale.costPerKg,
            totalCost: directBale.totalCost,
            grade: directBale.grade,
            stockEntryDate: directBale.stockEntryDate,
            pressedAt: directBale.pressedAt,
            finalizedAt: directBale.finalizedAt,
            workerName: directWorkerName,
            createdAt: directBale.createdAt,
            updatedAt: directBale.updatedAt,
            deletedAt: directBale.deletedAt,
          },
          locationInfo,
          pressingBatch: null,
          mixBatch: null,
          containers_used: [],
          loadedOnOrder: directLoadedOnOrder,
          auditHistory: directAuditHistory,
        });
      }

      let printedByName = null;
      let scannedByName = null;
      if (labelPrint.printedByUserId) {
        const printedUser = await storage.getUser(labelPrint.printedByUserId);
        printedByName = printedUser?.username || null;
      }
      if (labelPrint.scannedByUserId) {
        const scannedUser = await storage.getUser(labelPrint.scannedByUserId);
        scannedByName = scannedUser?.username || null;
      }

      let product = null;
      if (labelPrint.productId) {
        product = await storage.getBaleProductById(labelPrint.productId);
      } else {
        product = await storage.getBaleProductByArticleCode(labelPrint.articleCode, companyId);
      }

      // ── Enrich with factory_bales data (stable id first, normalized reference fallback) ──
      let baleInfo: any = null;
      let locationInfo = null;
      let pressingBatch = null;
      let mixBatch = null;
      let containers_used: unknown[] = [];

      const normalizedBaleReferenceMatch = sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`;
      let factoryBale: typeof factoryBales.$inferSelect | undefined;

      if (labelPrint.productionBaleId) {
        [factoryBale] = await db
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, labelPrint.productionBaleId)))
          .limit(1);
      }

      if (!factoryBale) {
        const fallbackFactoryBales = await db
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), normalizedBaleReferenceMatch))
          .limit(2);

        if (fallbackFactoryBales.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }
        factoryBale = fallbackFactoryBales[0];
      }

      if (factoryBale) {
        // Use the name stored on the bale row directly — this matches what the bale history page shows.
        const resolvedProductName = factoryBale.productName;

        // Use stored workerName first (denormalized); fall back to join if not yet populated
        let workerName: string | null = factoryBale.workerName ?? null;
        if (!workerName && factoryBale.finalizedBy) {
          const [wk] = await db
            .select({ fullName: factoryWorkers.fullName })
            .from(factoryWorkers)
            .where(eq(factoryWorkers.id, factoryBale.finalizedBy))
            .limit(1);
          if (wk) workerName = wk.fullName;
        }

        baleInfo = {
          id: factoryBale.id,
          baleCode: factoryBale.baleCode,
          productName: resolvedProductName,
          status: factoryBale.status,
          weightKg: factoryBale.weightKg,
          costPerKg: factoryBale.costPerKg,
          totalCost: factoryBale.totalCost,
          grade: factoryBale.grade,
          stockEntryDate: factoryBale.stockEntryDate,
          pressedAt: factoryBale.pressedAt,
          finalizedAt: factoryBale.finalizedAt,
          workerName,
          createdAt: factoryBale.createdAt,
          updatedAt: factoryBale.updatedAt,
          deletedAt: factoryBale.deletedAt,
        };

        // Get location
        if (factoryBale.erpLocationId) {
          const [loc] = await db
            .select({ id: locations.id, name: locations.name, city: locations.city, state: locations.state })
            .from(locations)
            .where(eq(locations.id, factoryBale.erpLocationId))
            .limit(1);
          if (loc) locationInfo = loc;
        }

        // Get pressing batch
        if (factoryBale.pressingBatchId) {
          const [pb] = await db
            .select()
            .from(factoryPressingBatches)
            .where(eq(factoryPressingBatches.id, factoryBale.pressingBatchId))
            .limit(1);
          if (pb) {
            pressingBatch = {
              id: pb.id,
              status: pb.status,
              expectedCount: pb.expectedCount,
              finalizedAt: pb.finalizedAt,
              notes: pb.notes,
            };

            // Get mix batch
            if (pb.mixBatchId) {
              const [mb] = await db
                .select()
                .from(factoryMixBatches)
                .where(eq(factoryMixBatches.id, pb.mixBatchId))
                .limit(1);
              if (mb) {
                mixBatch = {
                  id: mb.id,
                  batchCode: mb.batchCode,
                  batchNumber: mb.batchNumber,
                  name: mb.name,
                  batchDate: mb.batchDate,
                  totalWeightKg: mb.totalWeightKg,
                  costPerKg: mb.costPerKg,
                  status: mb.status,
                  operatorUser: mb.operatorUser,
                };

                // Get container sources for this mix batch
                const sources = await db
                  .select()
                  .from(factoryMixBatchSources)
                  .where(eq(factoryMixBatchSources.mixBatchId, mb.id));

                const containerIds = [...new Set(sources.filter((s) => s.containerId).map((s) => s.containerId!))];
                if (containerIds.length > 0) {
                  const containerRows = await db
                    .select()
                    .from(factoryContainers)
                    .where(inArray(factoryContainers.id, containerIds));

                  const supplierIds = [...new Set(containerRows.filter((c) => c.supplierId).map((c) => c.supplierId!))];
                  const supplierRows =
                    supplierIds.length > 0
                      ? await db.select().from(factorySuppliers).where(inArray(factorySuppliers.id, supplierIds))
                      : [];
                  const supplierMap = new Map(supplierRows.map((s) => [s.id, s.name]));

                  containers_used = containerRows.map((c) => {
                    const src = sources.find((s) => s.containerId === c.id);
                    return {
                      id: c.id,
                      containerNumber: c.containerNumber,
                      origin: c.origin,
                      arrivalDate: c.arrivalDate,
                      status: c.status,
                      supplierName: c.supplierId ? supplierMap.get(c.supplierId) || null : null,
                      weightKgUsed: src?.weightKg || null,
                      currencyCode: c.currencyCode,
                      ratePerKg: c.ratePerKg,
                    };
                  });
                }
              }
            }
          }
        }
      }

      // ── Check if this bale was loaded onto an outbound customer order ──
      // Fetch ALL assignments for this bale reference and pick the best-status one.
      // A bale can appear in multiple orders (e.g. moved from a cancelled order to a
      // finalized invoice). Deleted orders are historical only and are excluded.
      const statusPriority: Record<string, number> = {
        FINALIZED: 0,
        SOLD: 1,
        DISPATCHED: 2,
        VERIFIED: 3,
        PENDING_VERIFICATION: 4,
        LOADING: 5,
        DRAFT: 6,
        CANCELLED: 7,
      };
      let loadedOnOrder = null;
      const orderBaleRows = await db
        .select()
        .from(customerOrderBales)
        .where(sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`);

      if (orderBaleRows.length > 0) {
        // Fetch all matching non-deleted orders for the current company in one query.
        const orderIds = [...new Set(orderBaleRows.map((r) => r.orderId))];
        const orders = await db
          .select()
          .from(customerOrders)
          .leftJoin(customers, eq(customerOrders.customerId, customers.id))
          .where(
            and(
              inArray(customerOrders.id, orderIds),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          );

        if (orders.length > 0) {
          // Pick the order with the best (lowest priority number) status
          const bestOrder = orders.sort((a, b) => {
            const pa = statusPriority[a.customer_orders.status] ?? 99;
            const pb = statusPriority[b.customer_orders.status] ?? 99;
            return pa - pb;
          })[0];
          const matchingBaleRow = orderBaleRows.find((r) => r.orderId === bestOrder.customer_orders.id);
          if (matchingBaleRow) {
            loadedOnOrder = {
              orderId: bestOrder.customer_orders.id,
              invoiceNumber: bestOrder.customer_orders.invoiceNumber,
              orderDate: bestOrder.customer_orders.orderDate,
              status: bestOrder.customer_orders.status,
              containerNumber: bestOrder.customer_orders.containerNumber,
              shippingCompany: bestOrder.customer_orders.shippingCompany,
              containerNotes: bestOrder.customer_orders.containerNotes,
              loadingStartedAt: bestOrder.customer_orders.loadingStartedAt,
              loadingFinalizedAt: bestOrder.customer_orders.loadingFinalizedAt,
              grandTotal: bestOrder.customer_orders.grandTotal,
              totalQtyBales: bestOrder.customer_orders.totalQtyBales,
              customerName: bestOrder.customers?.legalName || null,
              priceUsed: matchingBaleRow.priceUsed,
              baleWeight: matchingBaleRow.weight,
              scannedBy: matchingBaleRow.scannedBy || null,
            };
          }
        }
      }

      // Mark isInLoadingOrder on baleInfo so callers (e.g. Ground Scan) can show the right status
      if (baleInfo && loadedOnOrder?.status === "LOADING") {
        baleInfo.isInLoadingOrder = true;
      }

      // If the bale's stored status is IN_STOCK but it's already on a finalized order,
      // derive the correct effective status so the Bale Explorer shows it accurately.
      if (
        baleInfo &&
        baleInfo.status === "IN_STOCK" &&
        loadedOnOrder?.status &&
        ["FINALIZED", "DISPATCHED", "SOLD"].includes(loadedOnOrder.status)
      ) {
        baleInfo.status = "SOLD";
      }

      // Fetch audit history for this bale
      let auditHistory: unknown[] = [];
      if (baleInfo?.id) {
        auditHistory = await db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            username: auditLog.username,
            changes: auditLog.changes,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(and(eq(auditLog.tableName, "factory_bales"), eq(auditLog.recordId, baleInfo.id)))
          .orderBy(desc(auditLog.createdAt))
          .limit(30);
      }

      res.json({
        labelPrint: { ...labelPrint, printedByName, scannedByName },
        product: product || null,
        baleInfo,
        locationInfo,
        pressingBatch,
        mixBatch,
        containers_used,
        loadedOnOrder,
        auditHistory,
      });
    } catch (error: unknown) {
      logger.error("Error looking up reference:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Mark a label as scanned
  app.post("/api/lookup/reference/:referenceNumber/scan", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
      const labelMatches = await db
        .select({ id: baleLabelPrints.id })
        .from(baleLabelPrints)
        .where(
          and(
            sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
            eq(baleLabelPrints.companyId, companyId)
          )
        )
        .limit(2);

      if (labelMatches.length === 0) {
        return res.status(404).json({ message: "Reference number not found" });
      }
      if (labelMatches.length > 1) {
        return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
      }

      const [updated] = await db
        .update(baleLabelPrints)
        .set({
          scannedByUserId: req.session.userId || null,
          scannedAt: new Date(),
        })
        .where(eq(baleLabelPrints.id, labelMatches[0].id))
        .returning();

      const scannedUser = await storage.getUser(req.session.userId!);
      res.json({ ...updated, scannedByName: scannedUser?.username || null });
    } catch (error: unknown) {
      logger.error("Error scanning label:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Admin: Delete bale/reference everywhere (soft-delete the factory bale)
  app.delete(
    "/api/lookup/reference/:referenceNumber/delete-everywhere",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
        const labelMatches = await db
          .select({ id: baleLabelPrints.id, productionBaleId: baleLabelPrints.productionBaleId })
          .from(baleLabelPrints)
          .where(
            and(
              sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
              eq(baleLabelPrints.companyId, companyId)
            )
          )
          .limit(2);

        const linkedBaleIds = [
          ...new Set(labelMatches.map((label) => label.productionBaleId).filter((id): id is number => id != null)),
        ];
        if (linkedBaleIds.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        let bale: typeof factoryBales.$inferSelect | undefined;
        if (linkedBaleIds.length === 1) {
          [bale] = await db
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, linkedBaleIds[0])))
            .limit(1);
        }

        if (!bale) {
          const baleMatches = await db
            .select()
            .from(factoryBales)
            .where(
              and(
                sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
                eq(factoryBales.companyId, companyId)
              )
            )
            .limit(2);

          if (baleMatches.length === 0) {
            return res.status(404).json({ message: "Bale not found for this reference" });
          }
          if (baleMatches.length > 1) {
            return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
          }
          bale = baleMatches[0];
        }

        // Guard: refuse if bale is on any finalized/locked non-deleted customer order.
        // A deleted test/order must not keep a bale permanently locked.
        const orderBaleRows = await db
          .select({ orderId: customerOrderBales.orderId })
          .from(customerOrderBales)
          .where(sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`);

        if (orderBaleRows.length > 0) {
          const orderIds = [...new Set(orderBaleRows.map((row) => row.orderId))];
          const orders = await db
            .select({ status: customerOrders.status })
            .from(customerOrders)
            .where(
              and(
                inArray(customerOrders.id, orderIds),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt)
              )
            );
          if (orders.some((order) => ["FINALIZED", "VERIFIED", "DISPATCHED", "SOLD"].includes(order.status))) {
            return res
              .status(409)
              .json({ message: "This bale is linked to a finalized/locked order and cannot be deleted from here." });
          }
        }

        const deletedAt = new Date();
        await db
          .update(factoryBales)
          .set({ status: "DELETED", deletedAt, updatedAt: deletedAt })
          .where(and(eq(factoryBales.id, bale.id), eq(factoryBales.companyId, companyId)));

        // Write audit entry so "Deleted by" info is available on the barcode lookup
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "delete",
          tableName: "factory_bales",
          recordId: bale.id,
          recordIdentifier: referenceNumber,
          changes: { status: { old: bale.status, new: "DELETED" } },
        });

        res.json({ message: "Bale deleted from linked records" });
      } catch (error: unknown) {
        logger.error("Error deleting bale everywhere:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Admin: Change the linked bale product (article code / product name) for a reference
  app.patch(
    "/api/lookup/reference/:referenceNumber/change-product",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
        const { newProductId } = req.body;

        if (!newProductId || typeof newProductId !== "number") {
          return res.status(400).json({ message: "newProductId (number) is required" });
        }

        const labelMatches = await db
          .select({ id: baleLabelPrints.id, productionBaleId: baleLabelPrints.productionBaleId })
          .from(baleLabelPrints)
          .where(
            and(
              sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
              eq(baleLabelPrints.companyId, companyId)
            )
          )
          .limit(2);

        const linkedBaleIds = [
          ...new Set(labelMatches.map((label) => label.productionBaleId).filter((id): id is number => id != null)),
        ];
        if (linkedBaleIds.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        let bale: typeof factoryBales.$inferSelect | undefined;
        if (linkedBaleIds.length === 1) {
          [bale] = await db
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, linkedBaleIds[0])))
            .limit(1);
        }

        if (!bale) {
          const baleMatches = await db
            .select()
            .from(factoryBales)
            .where(
              and(
                sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
                eq(factoryBales.companyId, companyId)
              )
            )
            .limit(2);

          if (baleMatches.length === 0) {
            return res.status(404).json({ message: "Bale not found for this reference" });
          }
          if (baleMatches.length > 1) {
            return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
          }
          bale = baleMatches[0];
        }

        if (labelMatches.length > 1 && linkedBaleIds.length === 0) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        // Guard: locked non-deleted order only.
        const orderBaleRows = await db
          .select({ orderId: customerOrderBales.orderId })
          .from(customerOrderBales)
          .where(sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`);

        if (orderBaleRows.length > 0) {
          const orderIds = [...new Set(orderBaleRows.map((row) => row.orderId))];
          const orders = await db
            .select({ status: customerOrders.status })
            .from(customerOrders)
            .where(
              and(
                inArray(customerOrders.id, orderIds),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt)
              )
            );
          if (orders.some((order) => ["FINALIZED", "VERIFIED", "DISPATCHED", "SOLD"].includes(order.status))) {
            return res
              .status(409)
              .json({ message: "This bale is linked to a finalized/locked order and cannot be changed." });
          }
        }

        const [newProduct] = await db
          .select()
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, newProductId), eq(factoryBaleProducts.companyId, companyId)))
          .limit(1);

        if (!newProduct) return res.status(404).json({ message: "Target product not found" });

        const newArticleCode = newProduct.articleCode || newProduct.code;
        const newBaleCode = newProduct.code;
        const newProductName = newProduct.name;

        await db.transaction(async (tx) => {
          await tx
            .update(factoryBales)
            .set({
              productId: newProduct.id,
              articleCode: newArticleCode,
              baleCode: newBaleCode,
              productName: newProductName,
              updatedAt: new Date(),
            })
            .where(and(eq(factoryBales.id, bale.id), eq(factoryBales.companyId, companyId)));

          if (linkedBaleIds.length === 1) {
            await tx
              .update(baleLabelPrints)
              .set({ articleCode: newArticleCode })
              .where(and(eq(baleLabelPrints.productionBaleId, bale.id), eq(baleLabelPrints.companyId, companyId)));
          } else if (labelMatches.length === 1) {
            await tx
              .update(baleLabelPrints)
              .set({ articleCode: newArticleCode })
              .where(eq(baleLabelPrints.id, labelMatches[0].id));
          }
        });

        res.json({ message: "Bale product changed", newArticleCode, newProductName });
      } catch (error: unknown) {
        logger.error("Error changing bale product:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
