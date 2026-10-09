/**
 * Factory FX-rate CRUD routes.
 *
 * Manual foreign-exchange rate management for factory companies (list,
 * latest, by-date lookup, create, delete). Extracted verbatim from
 * factoryBalesRoutes.ts as a sub-registrar, matching the pattern already
 * used for mix-batch and bale-export routes; behaviour is unchanged.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getOrFetchFxRateToUsd } from "./_helpers";
import { factoryFxRates, insertFactoryFxRateSchema } from "@shared/schema";
import { deleteFactoryFxRates, saveFactoryFxRate } from "../../services/accounting/exchangeRateWrites";

/** Saving or removing a rate (wave 14, owner decision 2); Developer passes requireRole too. */
const RATE_EDITOR_ROLES = ["Admin", "Owner"] as const;

export function registerFactoryFxRatesRoutes(app: Express) {
  app.get("/api/factory/fx-rates", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { currencyCode } = req.query;
      // Only return manually-set rates in the UI list (auto rows are internal cache only)
      const conditions = [eq(factoryFxRates.companyId, companyId), eq(factoryFxRates.source, "manual")];
      if (currencyCode) conditions.push(eq(factoryFxRates.currencyCode, currencyCode as string));
      const results = await db
        .select()
        .from(factoryFxRates)
        .where(and(...conditions))
        .orderBy(desc(factoryFxRates.effectiveDate));
      res.json(results);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/fx-rates/latest/:currencyCode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const currency = req.params.currencyCode.toUpperCase();
      const today = getClientDate(req);
      try {
        const rate = await getOrFetchFxRateToUsd(companyId, currency, today);
        res.json({ rate, effectiveDate: today });
      } catch (err: unknown) {
        const [fallback] = await db
          .select()
          .from(factoryFxRates)
          .where(and(eq(factoryFxRates.companyId, companyId), eq(factoryFxRates.currencyCode, currency)))
          .orderBy(desc(factoryFxRates.effectiveDate))
          .limit(1);
        if (fallback) {
          res.json({ rate: fallback.rateToUsd, effectiveDate: fallback.effectiveDate });
        } else {
          res.status(404).json({ message: getErrorMessage(err) });
        }
      }
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/fx-rates/:currencyCode/:date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const currency = req.params.currencyCode.toUpperCase();
      const dateISO = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
        return res.status(400).json({ message: "Date must be YYYY-MM-DD format" });
      }
      const rate = await getOrFetchFxRateToUsd(companyId, currency, dateISO);
      res.json({ rate, effectiveDate: dateISO });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Adds a manual rate effective from its date; the save and its audit (the rate it
  // supersedes on that date, and the new one) commit together.
  app.post(
    "/api/factory/fx-rates",
    requireAuth,
    requireRole(...RATE_EDITOR_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const today = getClientDate(req);
        const parsed = insertFactoryFxRateSchema.parse({
          effectiveDate: today,
          ...req.body,
          companyId,
          source: "manual",
        });
        const rate = await saveFactoryFxRate(
          { userId: req.session.userId!, username: req.session.username || "unknown", companyId },
          {
            currencyCode: parsed.currencyCode.trim().toUpperCase(),
            rateToUsd: parsed.rateToUsd,
            effectiveDate: parsed.effectiveDate,
          }
        );
        res.json(rate);
      } catch (error: unknown) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // DELETE by currency code — removes all rows (manual + auto) for that currency,
  // audited with the removed rows in the same transaction.
  app.delete(
    "/api/factory/fx-rates/:currency",
    requireAuth,
    requireRole(...RATE_EDITOR_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const currency = req.params.currency.toUpperCase();
        await deleteFactoryFxRates(
          { userId: req.session.userId!, username: req.session.username || "unknown", companyId },
          currency
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
