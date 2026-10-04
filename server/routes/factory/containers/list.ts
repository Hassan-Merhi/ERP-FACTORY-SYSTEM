/**
 * factoryContainersRoutes: FactoryContainerList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factorySuppliers, factoryContainers, ledgerAccounts } from "@shared/schema";
import { eq, and, asc, desc, sql, isNull } from "drizzle-orm";

export function registerFactoryContainerListRoutes(app: Express) {
  app.get("/api/factory/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select({
          id: factoryContainers.id,
          companyId: factoryContainers.companyId,
          containerNumber: factoryContainers.containerNumber,
          supplierId: factoryContainers.supplierId,
          origin: factoryContainers.origin,
          totalKg: factoryContainers.totalKg,
          ratePerKg: factoryContainers.ratePerKg,
          currencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          fxRateToUsdImport: factoryContainers.fxRateToUsdImport,
          fxRateToUsdOffload: factoryContainers.fxRateToUsdOffload,
          fxRateSource: factoryContainers.fxRateSource,
          fxRateDateImport: factoryContainers.fxRateDateImport,
          fxRateDateOffload: factoryContainers.fxRateDateOffload,
          ratePerKgUsd: factoryContainers.ratePerKgUsd,
          finalPayableAmountUsd: factoryContainers.finalPayableAmountUsd,
          declaredKg: factoryContainers.declaredKg,
          actualReceivedKg: factoryContainers.actualReceivedKg,
          finalPayableAmount: factoryContainers.finalPayableAmount,
          differenceKg: factoryContainers.differenceKg,
          arrivalDate: factoryContainers.arrivalDate,
          notes: factoryContainers.notes,
          status: factoryContainers.status,
          freight: factoryContainers.freight,
          freightCurrencyCode: factoryContainers.freightCurrencyCode,
          freightAccountId: factoryContainers.freightAccountId,
          freightPaidBy: factoryContainers.freightPaidBy,
          freightOwnAccountId: factoryContainers.freightOwnAccountId,
          freightSupplierId: factoryContainers.freightSupplierId,
          otherCharges: factoryContainers.otherCharges,
          otherChargesAccountId: factoryContainers.otherChargesAccountId,
          commissionAmount: factoryContainers.commissionAmount,
          commissionCurrencyCode: factoryContainers.commissionCurrencyCode,
          commissionAccountId: factoryContainers.commissionAccountId,
          commissionSupplierId: factoryContainers.commissionSupplierId,
          commissionNotes: factoryContainers.commissionNotes,
          createdAt: factoryContainers.createdAt,
          updatedAt: factoryContainers.updatedAt,
          supplierName: factorySuppliers.name,
          additionalChargesSum: sql<string>`COALESCE((
            SELECT SUM(
              CASE
                WHEN COALESCE(foac.currency_code, 'USD') = COALESCE(${factoryContainers.currencyCode}, 'USD')
                  THEN foac.amount::numeric
                WHEN COALESCE(foac.currency_code, 'USD') = 'USD'
                  THEN foac.amount::numeric / NULLIF(COALESCE(${factoryContainers.fxRateToUsd}, '1')::numeric, 0)
                ELSE foac.amount::numeric * COALESCE(foac.fx_rate_to_usd, '1')::numeric
                     / NULLIF(COALESCE(${factoryContainers.fxRateToUsd}, '1')::numeric, 0)
              END
            )
            FROM factory_offload_additional_charges foac
            WHERE foac.container_id = ${factoryContainers.id}
            AND foac.company_id = ${factoryContainers.companyId}
          ), 0)`,
          preRegisteredChargesSum: sql<string>`COALESCE((
            SELECT SUM(
              CASE
                WHEN COALESCE(fcoc.currency_code, 'USD') = COALESCE(${factoryContainers.currencyCode}, 'USD')
                  THEN fcoc.amount::numeric
                WHEN COALESCE(fcoc.currency_code, 'USD') = 'USD'
                  THEN fcoc.amount::numeric / NULLIF(COALESCE(${factoryContainers.fxRateToUsd}, '1')::numeric, 0)
                ELSE fcoc.amount::numeric
              END
            )
            FROM factory_container_other_charges fcoc
            WHERE fcoc.container_id = ${factoryContainers.id}
            AND fcoc.company_id = ${factoryContainers.companyId}
          ), 0)`,
          preRegisteredChargesCount: sql<number>`COALESCE((
            SELECT COUNT(*)
            FROM factory_container_other_charges fcoc
            WHERE fcoc.container_id = ${factoryContainers.id}
            AND fcoc.company_id = ${factoryContainers.companyId}
          ), 0)`,
          preRegisteredChargesByCurrency: sql<string>`COALESCE(
            (SELECT json_agg(json_build_object('currencyCode', cc, 'amount', total::text))
             FROM (
               SELECT COALESCE(currency_code, 'USD') AS cc, SUM(amount::numeric) AS total
               FROM factory_container_other_charges
               WHERE container_id = ${factoryContainers.id}
               AND company_id = ${factoryContainers.companyId}
               GROUP BY COALESCE(currency_code, 'USD')
             ) t),
            '[]'::json)`,
          destination: factoryContainers.destination,
          dutyAmount: factoryContainers.dutyAmount,
          dutyStatus: factoryContainers.dutyStatus,
          trackingEnabled: factoryContainers.trackingEnabled,
          trackingAutoUpdate: factoryContainers.trackingAutoUpdate,
          trackingCarrierHint: factoryContainers.trackingCarrierHint,
          trackingProvider: factoryContainers.trackingProvider,
          trackingLastStatus: factoryContainers.trackingLastStatus,
          trackingLastLocation: factoryContainers.trackingLastLocation,
          trackingLastCheckedAt: factoryContainers.trackingLastCheckedAt,
          trackingLastEventDate: factoryContainers.trackingLastEventDate,
          trackingLastDescription: factoryContainers.trackingLastDescription,
          trackingError: factoryContainers.trackingError,
          trackingDetectedCarrier: factoryContainers.trackingDetectedCarrier,
          trackingNextCheckAt: factoryContainers.trackingNextCheckAt,
          trackingLastSkipReason: factoryContainers.trackingLastSkipReason,
        })
        .from(factoryContainers)
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            isNull(factoryContainers.deletedAt),
            // activeOnly=true: restrict to OTW statuses (excludes PARTIALLY_RECEIVED, OFFLOADED, RECEIVED)
            req.query.activeOnly === "true"
              ? sql`${factoryContainers.status} IN ('PENDING', 'IN_TRANSIT', 'ARRIVED')`
              : undefined
          )
        )
        .orderBy(desc(factoryContainers.createdAt));

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory containers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Factory-owned ledger picker for container workflows such as post-offload charges.
  // It intentionally avoids the shared ERP /api/ledger-accounts permission surface.
  app.get("/api/factory/containers/account-options", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          accountType: ledgerAccounts.accountType,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        )
        .orderBy(asc(ledgerAccounts.code), asc(ledgerAccounts.name));

      res.json(rows);
    } catch (error: unknown) {
      logger.error("Error fetching Factory container account options:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── GET single container by ID ────────────────────────────────────────────
  app.get("/api/factory/containers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const [row] = await db
        .select({
          id: factoryContainers.id,
          containerNumber: factoryContainers.containerNumber,
          supplierId: factoryContainers.supplierId,
          origin: factoryContainers.origin,
          totalKg: factoryContainers.totalKg,
          declaredKg: factoryContainers.declaredKg,
          actualReceivedKg: factoryContainers.actualReceivedKg,
          ratePerKg: factoryContainers.ratePerKg,
          ratePerKgUsd: factoryContainers.ratePerKgUsd,
          currencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          finalPayableAmount: factoryContainers.finalPayableAmount,
          finalPayableAmountUsd: factoryContainers.finalPayableAmountUsd,
          freight: factoryContainers.freight,
          freightCurrencyCode: factoryContainers.freightCurrencyCode,
          freightAccountId: factoryContainers.freightAccountId,
          freightPaidBy: factoryContainers.freightPaidBy,
          freightOwnAccountId: factoryContainers.freightOwnAccountId,
          freightSupplierId: factoryContainers.freightSupplierId,
          otherCharges: factoryContainers.otherCharges,
          commissionAmount: factoryContainers.commissionAmount,
          commissionCurrencyCode: factoryContainers.commissionCurrencyCode,
          commissionSupplierId: factoryContainers.commissionSupplierId,
          arrivalDate: factoryContainers.arrivalDate,
          status: factoryContainers.status,
          notes: factoryContainers.notes,
          supplierName: factorySuppliers.name,
        })
        .from(factoryContainers)
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)));
      if (!row) return res.status(404).json({ message: "Container not found" });
      res.json(row);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
