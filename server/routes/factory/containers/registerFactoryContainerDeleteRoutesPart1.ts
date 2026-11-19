// Extracted from ./delete.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { resolveStoredFxRateOrThrow } from "../../../services/factory/currencyConversion";
import { getOrCreateLedgerAccount, checkFactoryAdmin } from "../_helpers";
import { factoryContainers, vouchers } from "@shared/schema";
import { eq, and, inArray, ilike, isNull } from "drizzle-orm";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { FACTORY_APPROVED_HISTORICAL_RATES } from "../../../services/factory/factoryFxLegacyRepair";
import { toMoney } from "../../../lib/money";

export function registerFactoryContainerDeleteRoutesPart1(app: Express) {
  // Read-only, company-scoped preview for the historical import-credit repair.
  // Historic records must never be posted merely because someone loads a page.
  app.get("/api/factory/container-import-credit-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const useFixedHistoricalRates = req.query.fixedRates === "1";
      const active = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.companyId, companyId), isNull(factoryContainers.deletedAt)));
      const missing = [];
      for (const container of active) {
        if (!container.supplierId) continue;
        const goods = toMoney(container.totalKg).times(toMoney(container.ratePerKg));
        if (!goods.greaterThan(0)) continue;
        const posted = await db
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(eq(vouchers.companyId, companyId), ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${container.id}-%`))
          )
          .limit(1);
        if (posted.length) continue; // includes retired entries — never re-post an intentionally reversed document
        const code = (container.currencyCode || "USD").toUpperCase();
        const approvedRate = useFixedHistoricalRates
          ? FACTORY_APPROVED_HISTORICAL_RATES[code as keyof typeof FACTORY_APPROVED_HISTORICAL_RATES]
          : undefined;
        let rate: string | null = approvedRate ?? null;
        let repairable = true;
        if (!rate) {
          try {
            rate = String(
              resolveStoredFxRateOrThrow(container.currencyCode, container.fxRateToUsd, container.fxRateConfirmed)
            );
          } catch {
            repairable = false;
          }
        }
        missing.push({
          containerId: container.id,
          containerNumber: container.containerNumber,
          supplierId: container.supplierId,
          currency: code,
          nativeGoods: goods.toFixed(2),
          historicalRate: rate,
          rateSource: approvedRate ? "approved-fixed" : "container",
          expectedUsd: rate ? goods.times(toMoney(rate)).toFixed(2) : null,
          postingDate: container.createdAt ? new Date(container.createdAt).toISOString().slice(0, 10) : null,
          repairable,
        });
      }
      res.json({
        companyId,
        writePerformed: false,
        fixedRatesUsed: useFixedHistoricalRates ? FACTORY_APPROVED_HISTORICAL_RATES : null,
        count: missing.length,
        missing,
      });
    } catch (error: unknown) {
      logger.error("Factory import-credit preview failed", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Backfill: explicit Admin/Owner approved source IDs only. The posting service
  // creates a balanced journal and its immutable source identity per transaction.
  app.post("/api/factory/containers/backfill-import-credits", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { confirm, containerIds } = req.body || {};
      const useFixedHistoricalRates = req.body?.fixedRates === true;
      if (
        confirm !== true ||
        !Array.isArray(containerIds) ||
        !containerIds.length ||
        containerIds.length > 250 ||
        containerIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
        new Set(containerIds).size !== containerIds.length
      ) {
        return res.status(400).json({
          message: "Preview first, then explicitly confirm 1-250 unique numeric containerIds to backfill.",
        });
      }
      const allContainers = await db
        .select()
        .from(factoryContainers)
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            isNull(factoryContainers.deletedAt),
            inArray(factoryContainers.id, containerIds)
          )
        );
      if (allContainers.length !== containerIds.length) {
        return res
          .status(409)
          .json({ message: "Container selection has changed or includes deleted/other-company IDs. Preview again." });
      }

      let created = 0;
      let skipped = 0;
      const fxUnresolvedSkipped: string[] = [];

      for (const container of allContainers) {
        if (!container.supplierId) {
          skipped++;
          continue;
        }
        // Exact (was a float product).
        const goodsValue = toMoney(container.ratePerKg).times(toMoney(container.totalKg));
        if (goodsValue.lessThanOrEqualTo(0)) {
          skipped++;
          continue;
        }

        // Skip if an import voucher already exists for this container
        const existing = await db
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(eq(vouchers.companyId, companyId), ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${container.id}-%`))
          )
          .limit(1);
        if (existing.length > 0) {
          skipped++;
          continue;
        }

        // Fixed-rate historical repair is explicitly approved separately from
        // ordinary posting. It only overrides missing EUR/AUD goods journals.
        const code = (container.currencyCode || "USD").toUpperCase();
        const approvedRate = useFixedHistoricalRates
          ? FACTORY_APPROVED_HISTORICAL_RATES[code as keyof typeof FACTORY_APPROVED_HISTORICAL_RATES]
          : undefined;
        let backfillFxRate: number;
        try {
          backfillFxRate = approvedRate
            ? Number(approvedRate)
            : resolveStoredFxRateOrThrow(container.currencyCode, container.fxRateToUsd, container.fxRateConfirmed);
        } catch {
          skipped++;
          fxUnresolvedSkipped.push(container.containerNumber);
          continue;
        }

        const creationDate = container.createdAt
          ? new Date(container.createdAt).toISOString().slice(0, 10)
          : getClientDate(req);
        const importCostAccId = await getOrCreateLedgerAccount(companyId, "FACTORY_IMPORT_COST", "Factory Import Cost");
        // Phase 22 (C): through the engine with the container's goods identity
        // (the create route's) and its FACTORY-IMPORT-{container}- family number.
        await db.transaction((tx) =>
          postFactoryVoucherTx(tx, {
            companyId,
            voucherNumber: (generation) => `FACTORY-IMPORT-${container.id}-${generation}`,
            // Arrival date is an ETA, sometimes in the future. Goods liability
            // originated on the historical container creation date.
            voucherDate: creationDate,
            description: `Goods import - container ${container.containerNumber}`,
            currency: container.currencyCode || "USD",
            fxRateToUsd: String(backfillFxRate),
            source: { sourceType: "factory-container-import", sourceId: container.id, phase: "goods" },
            lines: [
              {
                ledgerAccountId: importCostAccId,
                debit: goodsValue,
                narration: `Goods import cost - container ${container.containerNumber}`,
              },
              {
                factorySupplierId: container.supplierId,
                credit: goodsValue,
                narration: `Goods payable to supplier - container ${container.containerNumber}`,
              },
            ],
          })
        );
        created++;
      }

      res.json({
        created,
        skipped,
        total: allContainers.length,
        fxUnresolvedSkipped,
        fixedRatesUsed: useFixedHistoricalRates ? FACTORY_APPROVED_HISTORICAL_RATES : null,
      });
    } catch (error: unknown) {
      logger.error("Error backfilling import credits:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
