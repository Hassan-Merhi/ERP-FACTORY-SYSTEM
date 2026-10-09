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
import { resolveFactoryFxRateToUsd, type FactoryFxRateResolution } from "../../services/factory/factoryFxRateReadOnly";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import { factoryFxRates, insertFactoryFxRateSchema } from "@shared/schema";
import {
  deleteFactoryFxRates,
  saveFactoryFxRate,
  saveFetchedFactoryFxRate,
} from "../../services/accounting/exchangeRateWrites";

/** Saving or removing a rate (wave 14, owner decision 2); Developer passes requireRole too. */
const RATE_EDITOR_ROLES = ["Admin", "Owner"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A looked-up rate; `suggestion` marks an external rate that is not recorded. */
function rateResponse(resolution: FactoryFxRateResolution) {
  return { ...resolution, suggestion: !resolution.saved };
}

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

  // Reads never write a rate (wave 17 C, owner decision 1). The response says
  // where the rate came from: `saved: false` (source "fetched") is the external
  // historical rate offered as a suggestion; it is recorded only by
  // POST /api/factory/fx-rates/fetched (Admin/Owner, audited). "Latest" is the
  // company's business date: a rate dated after it is never returned.
  app.get("/api/factory/fx-rates/latest/:currencyCode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const currency = req.params.currencyCode.toUpperCase();
      const today = await companyBusinessDate(companyId);
      try {
        res.json(rateResponse(await resolveFactoryFxRateToUsd(companyId, currency, today)));
      } catch (err: unknown) {
        res.status(404).json({ message: getErrorMessage(err) });
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
      if (!ISO_DATE.test(dateISO)) {
        return res.status(400).json({ message: "Date must be YYYY-MM-DD format" });
      }
      res.json(rateResponse(await resolveFactoryFxRateToUsd(companyId, currency, dateISO)));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Records the external historical rate for a date as a factory (auto) rate:
  // the server fetches it, and the save and its audit commit together. A rate
  // already recorded for that date is returned unchanged (created: false).
  app.post(
    "/api/factory/fx-rates/fetched",
    requireAuth,
    requireRole(...RATE_EDITOR_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const currencyCode = String(req.body?.currencyCode ?? "")
          .trim()
          .toUpperCase();
        if (!/^[A-Z]{3}$/.test(currencyCode) || currencyCode === "USD") {
          return res.status(400).json({ message: "A three-letter non-USD currency code is required" });
        }
        const effectiveDate =
          req.body?.date === undefined ? await companyBusinessDate(companyId) : String(req.body.date);
        if (!ISO_DATE.test(effectiveDate)) {
          return res.status(400).json({ message: "Date must be YYYY-MM-DD format" });
        }
        const { rate, created } = await saveFetchedFactoryFxRate(
          { userId: req.session.userId!, username: req.session.username || "unknown", companyId },
          { currencyCode, effectiveDate }
        );
        res.status(created ? 201 : 200).json({ ...rate, created });
      } catch (error: unknown) {
        res.status(502).json({ message: getErrorMessage(error) });
      }
    }
  );

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

  // DELETE by currency code (wave 17 C, owner decision 2): removes only the
  // manual rates no document used; recorded auto rates and every rate a
  // document may have been priced at are kept. Audited with the removed and the
  // kept rows in the same transaction; the response lists both.
  app.delete(
    "/api/factory/fx-rates/:currency",
    requireAuth,
    requireRole(...RATE_EDITOR_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const currency = req.params.currency.toUpperCase();
        const result = await deleteFactoryFxRates(
          { userId: req.session.userId!, username: req.session.username || "unknown", companyId },
          currency
        );
        res.json({ ok: true, ...result });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
