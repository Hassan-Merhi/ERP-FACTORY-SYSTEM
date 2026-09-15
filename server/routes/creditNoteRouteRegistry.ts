import type { Express } from "express";
import { isValidIsoDate } from "../lib/requestValidation";
import { registerCreditNoteRoutes as registerCreditNoteHandlers } from "./creditNoteRoutes";

/**
 * Keep request-boundary validation next to credit-note route registration
 * without growing the central application route registry.
 */
export function registerCreditNoteRoutes(app: Express): void {
  app.use("/api/credit-notes", (req, res, next) => {
    if (req.method !== "POST" || !req.session?.userId) return next();
    if (req.body?.voucherDate !== undefined && !isValidIsoDate(req.body.voucherDate)) {
      return res.status(400).json({ message: "voucherDate must be a valid YYYY-MM-DD date" });
    }
    next();
  });

  registerCreditNoteHandlers(app);
}
