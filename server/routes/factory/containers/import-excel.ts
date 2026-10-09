/**
 * factoryContainersRoutes: FactoryContainerImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry, getOrFetchFxRateToUsd } from "../_helpers";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { factorySuppliers, factoryContainers } from "@shared/schema";
import { eq } from "drizzle-orm";

export function registerFactoryContainerImportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 4b. Factory Containers - Excel Import
  // ───────────────────────────────────────────────

  app.post("/api/factory/containers/import-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows to import" });
      }

      const VALID_STATUSES = ["PENDING", "IN_TRANSIT", "AVAILABLE", "OFFLOADED"];
      const VALID_CURRENCIES = ["USD", "EUR", "AUD", "LBP", "GBP", "XOF", "XAF", "CFA"];

      const allSuppliers = await db.select().from(factorySuppliers).where(eq(factorySuppliers.companyId, companyId));

      const supplierMap = new Map<string, number>();
      allSuppliers.forEach((s) => supplierMap.set(s.name.toLowerCase().trim(), s.id));

      const results = [];
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        try {
          if (!row.containerNumber || !row.containerNumber.trim()) {
            errors.push(`Row ${rowNum}: Missing container number`);
            continue;
          }

          const status = (row.status || "PENDING").toUpperCase();
          if (!VALID_STATUSES.includes(status)) {
            errors.push(
              `Row ${rowNum} (${row.containerNumber}): Invalid status "${row.status}". Must be one of: ${VALID_STATUSES.join(", ")}`
            );
            continue;
          }

          const currencyCode = (row.currencyCode || "USD").toUpperCase();
          if (!VALID_CURRENCIES.includes(currencyCode)) {
            errors.push(`Row ${rowNum} (${row.containerNumber}): Invalid currency "${row.currencyCode}"`);
            continue;
          }

          const ratePerKg = parseFloat(row.ratePerKg || "0") || 0;
          const totalKg = parseFloat(row.totalKg || "0") || 0;

          if (row.totalKg && isNaN(parseFloat(row.totalKg))) {
            errors.push(`Row ${rowNum} (${row.containerNumber}): Invalid Total Kg value`);
            continue;
          }
          if (row.ratePerKg && isNaN(parseFloat(row.ratePerKg))) {
            errors.push(`Row ${rowNum} (${row.containerNumber}): Invalid Rate/Kg value`);
            continue;
          }

          const fxSource = (row.fxSource || "").toUpperCase() === "MANUAL" ? "manual" : "auto";
          const today = getClientDate(req);
          const importDate = row.arrivalDate || today;

          let fxRate: number;
          if (fxSource === "manual" && row.fxRateToUsd) {
            const parsedManualRate = parseFloat(row.fxRateToUsd);
            if (currencyCode !== "USD" && !(parsedManualRate > 0)) {
              errors.push(`Row ${rowNum} (${row.containerNumber}): Invalid manual fxRateToUsd for ${currencyCode}`);
              continue;
            }
            fxRate = parsedManualRate;
          } else if (fxSource === "manual") {
            errors.push(`Row ${rowNum} (${row.containerNumber}): fxSource is MANUAL but fxRateToUsd was not provided`);
            continue;
          } else {
            try {
              fxRate = parseFloat(await getOrFetchFxRateToUsd(companyId, currencyCode, importDate));
            } catch (fxErr: unknown) {
              errors.push(`Row ${rowNum} (${row.containerNumber}): ${getErrorMessage(fxErr)}`);
              continue;
            }
          }

          await db.transaction(async (tx) => {
            let supplierId: number | null = null;
            if (row.supplierName && row.supplierName.trim()) {
              const key = row.supplierName.toLowerCase().trim();
              if (supplierMap.has(key)) {
                supplierId = supplierMap.get(key)!;
              } else {
                const [newSupplier] = await tx
                  .insert(factorySuppliers)
                  .values({
                    companyId,
                    name: row.supplierName.trim(),
                    isActive: true,
                  })
                  .returning();
                supplierMap.set(key, newSupplier.id);
                supplierId = newSupplier.id;
              }
            }

            const ratePerKgUsd = currencyCode === "USD" ? ratePerKg : ratePerKg * fxRate;

            const commAmt = row.commissionAmount ? String(parseFloat(row.commissionAmount) || 0) : "0";
            const commCcy = (row.commissionCurrencyCode || "USD").toUpperCase();

            const [container] = await tx
              .insert(factoryContainers)
              .values({
                companyId,
                containerNumber: row.containerNumber.trim(),
                supplierId,
                origin: row.origin || null,
                totalKg: totalKg ? String(totalKg) : null,
                ratePerKg: ratePerKg ? String(ratePerKg) : null,
                currencyCode,
                fxRateToUsd: String(fxRate),
                fxRateToUsdImport: String(fxRate),
                fxRateSource: fxSource,
                fxRateDateImport: importDate,
                ratePerKgUsd: String(ratePerKgUsd),
                // Explicitly resolved above (validated manual entry or a real auto-fetch).
                fxRateConfirmed: true,
                arrivalDate: row.arrivalDate || null,
                notes: row.notes || null,
                status,
                commissionAmount: commAmt,
                commissionCurrencyCode: commCcy,
              })
              .returning();

            const excelDescParts = [
              container.containerNumber,
              row.supplierName?.trim() || null,
              totalKg > 0 ? `${totalKg.toLocaleString()} kg` : null,
              ratePerKg > 0 ? `${ratePerKg} ${currencyCode}/kg` : null,
            ].filter(Boolean);
            await writeDaybookEntry(tx, {
              companyId,
              txDate: container.arrivalDate || importDate,
              txType: "CONTAINER_IMPORT",
              referenceId: container.id,
              referenceTable: "factory_containers",
              description: excelDescParts.join(" · "),
              currencyCode: container.currencyCode || "USD",
              amountCurrency: ratePerKg * totalKg,
              fxRateToUsd: fxRate,
            });

            // Wave 8.4 continuation: the imported commission is journalled with the container.
            await syncContainerCommissionJournalTx(tx, companyId, container.id);

            results.push(container);
          });
        } catch (err: unknown) {
          errors.push(`Row ${rowNum} (${row.containerNumber || "unknown"}): ${getErrorMessage(err)}`);
        }
      }

      res.json({
        imported: results.length,
        errors,
        total: rows.length,
      });
    } catch (error: unknown) {
      logger.error("Error importing containers from Excel:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
