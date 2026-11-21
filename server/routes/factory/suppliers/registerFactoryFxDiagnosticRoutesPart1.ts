// Extracted from ./fxDiagnosticRoutes.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factorySuppliers,
} from "@shared/schema";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import { getRawMaterialReconciliation } from "../../../services/factory/rawMaterialReconciliation";
import { lineAmount } from "../../../lib/money";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

interface UnresolvedRow {
  source: "container" | "offload_additional_charge" | "commission";
  id: number;
  containerId: number;
  containerNumber: string | null;
  supplierId: number | null;
  supplierName: string | null;
  status: string | null;
  currencyCode: string | null;
  storedFxRateToUsd: string | null;
  fxRateConfirmed: boolean;
  amountNative: string | null;
  description: string | null;
}

export function registerFactoryFxDiagnosticRoutesPart1(app: Express) {
  app.get(
    "/api/factory/suppliers/fx-diagnostic",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const suppliers = await db
          .select({ id: factorySuppliers.id, name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.companyId, companyId));
        const supplierNameById = new Map<number, string>(suppliers.map((s) => [s.id, s.name]));

        // IMPORTANT: load ALL of this company's containers (not just non-USD ones) into
        // the lookup map. A non-USD charge/commission can be attached to a USD-currency
        // container — if that container is missing from the map, the charge/commission
        // row silently loses its real status (CLOSED/COMPLETED/OFFLOADED), which used to
        // let it slip past the manual-review classification below.
        const allContainers = await db
          .select()
          .from(factoryContainers)
          .where(eq(factoryContainers.companyId, companyId));
        const containerById = new Map(allContainers.map((c) => [c.id, c]));
        const nonUsdContainers = allContainers.filter((c) => c.currencyCode !== "USD");

        // Charges/commissions are scanned by companyId directly — NEVER gated on
        // "does this company have any non-USD containers", so a non-USD charge/commission
        // attached to a USD-currency container is still found and evaluated.
        const offloadCharges = await db
          .select()
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              ne(factoryOffloadAdditionalCharges.currencyCode, "USD")
            )
          );

        const commissions = await db
          .select()
          .from(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.companyId, companyId),
              ne(factoryContainerCommissions.currencyCode, "USD")
            )
          );

        const unresolved: UnresolvedRow[] = [];
        let containersScanned = 0;
        let chargesScanned = 0;
        let commissionsScanned = 0;

        for (const c of nonUsdContainers) {
          containersScanned++;
          const { looksSet } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
          if (!looksSet) {
            unresolved.push({
              source: "container",
              id: c.id,
              containerId: c.id,
              containerNumber: c.containerNumber,
              supplierId: c.supplierId,
              supplierName: c.supplierId ? supplierNameById.get(c.supplierId) || null : null,
              status: c.status,
              currencyCode: c.currencyCode,
              storedFxRateToUsd: c.fxRateToUsd,
              fxRateConfirmed: !!c.fxRateConfirmed,
              amountNative: c.ratePerKg && c.totalKg ? String(lineAmount(c.ratePerKg, c.totalKg).toNumber()) : null,
              description: `Container ${c.containerNumber}`,
            });
          }
        }

        for (const oc of offloadCharges) {
          chargesScanned++;
          const { looksSet } = resolveStoredFxRate(oc.currencyCode, oc.fxRateToUsd, oc.fxRateConfirmed);
          if (!looksSet) {
            const container = containerById.get(oc.containerId);
            const supplierId = oc.supplierId ?? container?.supplierId ?? null;
            unresolved.push({
              source: "offload_additional_charge",
              id: oc.id,
              containerId: oc.containerId,
              containerNumber: container?.containerNumber ?? null,
              supplierId,
              supplierName: supplierId ? supplierNameById.get(supplierId) || null : null,
              status: container?.status ?? null,
              currencyCode: oc.currencyCode,
              storedFxRateToUsd: oc.fxRateToUsd,
              fxRateConfirmed: !!oc.fxRateConfirmed,
              amountNative: oc.amount,
              description: oc.description,
            });
          }
        }

        for (const cm of commissions) {
          commissionsScanned++;
          const { looksSet } = resolveStoredFxRate(cm.currencyCode, cm.fxRateToUsd, cm.fxRateConfirmed);
          if (!looksSet) {
            const container = containerById.get(cm.containerId);
            unresolved.push({
              source: "commission",
              id: cm.id,
              containerId: cm.containerId,
              containerNumber: container?.containerNumber ?? null,
              supplierId: container?.supplierId ?? null,
              supplierName: container?.supplierId ? supplierNameById.get(container.supplierId) || null : null,
              status: container?.status ?? null,
              currencyCode: cm.currencyCode,
              storedFxRateToUsd: cm.fxRateToUsd,
              fxRateConfirmed: !!cm.fxRateConfirmed,
              amountNative: cm.commissionTotal,
              description: `Commission — ${cm.personName}`,
            });
          }
        }

        // Group for the summary views the UI/report will actually want.
        const bySupplier: Record<string, { supplierId: number | null; supplierName: string | null; count: number }> =
          {};
        const byCurrency: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        const byContainer: Record<
          number,
          { containerId: number; containerNumber: string | null; supplierName: string | null; rows: UnresolvedRow[] }
        > = {};

        for (const row of unresolved) {
          const supKey = String(row.supplierId ?? "none");
          if (!bySupplier[supKey])
            bySupplier[supKey] = { supplierId: row.supplierId, supplierName: row.supplierName, count: 0 };
          bySupplier[supKey].count++;

          const currencyKey = row.currencyCode ?? "UNKNOWN";
          byCurrency[currencyKey] = (byCurrency[currencyKey] || 0) + 1;

          const statusKey = row.status || "UNKNOWN";
          byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;

          if (!byContainer[row.containerId]) {
            byContainer[row.containerId] = {
              containerId: row.containerId,
              containerNumber: row.containerNumber,
              supplierName: row.supplierName,
              rows: [],
            };
          }
          byContainer[row.containerId].rows.push(row);
        }

        // CLOSED/COMPLETED/OFFLOADED containers must never be auto-repaired — surfaced
        // explicitly (using the FULL container status now that containerById always has
        // every container, not just non-USD ones) so the repair service and any human
        // reviewer always sees this correctly, even for a non-USD charge/commission
        // sitting on a USD-currency container.
        const manualReviewRequired = unresolved.filter(
          (r) => r.status === "CLOSED" || r.status === "COMPLETED" || r.status === "OFFLOADED"
        );

        const reconciliation = await getRawMaterialReconciliation(companyId);

        res.json({
          scannedAt: new Date().toISOString(),
          companyId,
          totals: {
            containersScanned,
            chargesScanned,
            commissionsScanned,
            unresolvedCount: unresolved.length,
            manualReviewRequiredCount: manualReviewRequired.length,
          },
          bySupplier: Object.values(bySupplier),
          byCurrency,
          byStatus,
          byContainer: Object.values(byContainer),
          manualReviewRequired,
          rows: unresolved,
          reconciliation,
        });
      } catch (error: unknown) {
        logger.error("Error running factory FX diagnostic:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
