/**
 * containerLoadedItemsRoutes: ContainerLoadedItemReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { buildAliasMap, resolveBarcode } from "../helpers/proformaBarcodeHelpers";
import { supplierContainerLoadedItems, supplierProformaLines, supplierProformas } from "@shared/schema";

import { verifyContainerOwnership } from "./_helpers";
import { toMoney } from "../../lib/money";
import { diff, times } from "./reportsTimes";
import { registerContainerLoadedItemReportRoutesPart2 } from "./registerContainerLoadedItemReportRoutesPart2";

export function registerContainerLoadedItemReportRoutes(app: Express, requireAuth: RequestHandler) {
  registerContainerLoadedItemReportRoutesPart1(app, requireAuth);
  registerContainerLoadedItemReportRoutesPart2(app, requireAuth);
}

function registerContainerLoadedItemReportRoutesPart1(app: Express, requireAuth: RequestHandler) {
  app.get(
    "/api/suppliers/:supplierId/containers/:containerId/verification-summary",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const supplierId = parseId(req.params.supplierId);
        if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
        const containerId = parseId(req.params.containerId);
        if (containerId === null) return res.status(400).json({ message: "Invalid id" });
        const proformaId = parseOptionalId(req.query.proformaId);
        if (!proformaId) return res.status(400).json({ message: "proformaId query param required" });

        if (!(await verifyContainerOwnership(containerId, companyId)))
          return res.status(403).json({ message: "Access denied" });

        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(
            and(
              eq(supplierProformas.id, proformaId),
              sql`(${supplierProformas.companyId} = ${companyId} OR (${supplierProformas.destinationCompanyId} = ${companyId} AND EXISTS (SELECT 1 FROM companies child WHERE child.id = ${companyId} AND child.parent_company_id = ${supplierProformas.companyId})))`
            )
          );
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const proformaLines = await db
          .select()
          .from(supplierProformaLines)
          .where(eq(supplierProformaLines.proformaId, proformaId));

        const loadedItems = await db
          .select()
          .from(supplierContainerLoadedItems)
          .where(eq(supplierContainerLoadedItems.containerId, containerId));

        const { map: aliasMap, conflicts: allAliasConflicts } = await buildAliasMap(companyId);

        // Only surface conflicts relevant to barcodes actually present in this
        // proforma/container pair, so unrelated stale conflicts elsewhere in
        // the company don't spam every verification screen.
        const relevantRawCodes = new Set([
          ...proformaLines.map((l) => (l.barcode || "").trim().toLowerCase()),
          ...loadedItems.map((i) => (i.barcode || "").trim().toLowerCase()),
        ]);
        const aliasConflicts = allAliasConflicts.filter((c) => relevantRawCodes.has(c.aliasCode.trim().toLowerCase()));

        const proformaByBarcode = new Map();
        for (const line of proformaLines) {
          const bc = resolveBarcode((line.barcode || "").trim(), aliasMap);
          if (proformaByBarcode.has(bc)) {
            const existing = proformaByBarcode.get(bc);
            existing.qty += line.qty;
          } else {
            proformaByBarcode.set(bc, {
              barcode: bc,
              itemName: line.itemName,
              qty: line.qty,
              weightPerBale: toMoney(line.weightPerBale).toNumber(),
              pricePerBale: toMoney(line.pricePerBale).toNumber(),
            });
          }
        }

        const loadedByBarcode = new Map();
        for (const item of loadedItems) {
          const bc = resolveBarcode((item.barcode || "").trim(), aliasMap);
          if (loadedByBarcode.has(bc)) {
            const existing = loadedByBarcode.get(bc);
            existing.qty += item.qty;
          } else {
            loadedByBarcode.set(bc, {
              barcode: bc,
              itemName: item.itemName || "",
              qty: item.qty,
              weightPerBale: toMoney(item.weightPerBale).toNumber(),
              pricePerBale: toMoney(item.pricePerBale).toNumber(),
            });
          }
        }

        const allBarcodes = new Set([...proformaByBarcode.keys(), ...loadedByBarcode.keys()]);
        const comparison = [];

        for (const barcode of allBarcodes) {
          const exp = proformaByBarcode.get(barcode);
          const loaded = loadedByBarcode.get(barcode);

          const expectedQty = exp?.qty || 0;
          const loadedQty = loaded?.qty || 0;
          const expectedWeightPerBale = exp?.weightPerBale || 0;
          const loadedWeightPerBale = loaded?.weightPerBale || 0;
          const expectedPricePerBale = exp?.pricePerBale || 0;
          const loadedPricePerBale = loaded?.pricePerBale || 0;

          const expectedWeightTotal = times(expectedQty, expectedWeightPerBale);
          const loadedWeightTotal = times(loadedQty, loadedWeightPerBale || expectedWeightPerBale);

          const expectedTotalValue = times(expectedQty, expectedPricePerBale);
          const loadedTotalValue = times(loadedQty, loadedPricePerBale || expectedPricePerBale);

          let statusQty: string;
          if (expectedQty === 0 && loadedQty > 0) statusQty = "LOADED_NOT_IN_PROFORMA";
          else if (expectedQty > 0 && loadedQty === 0) statusQty = "MISSING_FROM_LOADED";
          else if (loadedQty > expectedQty) statusQty = "OVER_LOADED";
          else if (loadedQty < expectedQty && loadedQty > 0) statusQty = "UNDER_LOADED";
          else statusQty = "MATCH";

          let priceStatus: string;
          const priceDiffPerBale = diff(loadedPricePerBale, expectedPricePerBale);
          if (!expectedPricePerBale || !loadedPricePerBale) priceStatus = "PRICE_UNKNOWN";
          else if (Math.abs(priceDiffPerBale) < 0.01) priceStatus = "PRICE_MATCH";
          else priceStatus = "PRICE_DIFF";

          const totalPriceDiff = times(loadedQty, priceDiffPerBale);

          comparison.push({
            barcode,
            itemName: exp?.itemName || loaded?.itemName || barcode,
            expectedQty,
            loadedQty,
            expectedWeightPerBale,
            loadedWeightPerBale,
            expectedWeightTotal,
            loadedWeightTotal,
            expectedPricePerBale,
            loadedPricePerBale,
            expectedTotalValue,
            loadedTotalValue,
            statusQty,
            priceStatus,
            priceDiffPerBale,
            totalPriceDiff,
          });
        }

        res.json({
          proforma: { id: proforma.id, reference: proforma.reference },
          containerId,
          supplierId,
          comparison,
          proformaLines,
          loadedItems,
          aliasConflicts,
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
