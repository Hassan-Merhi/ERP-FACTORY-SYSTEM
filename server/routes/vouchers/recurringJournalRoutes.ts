import type { Express, Request, Response } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  RecurringJournalError,
  getRecurringJournalForSource,
  getRecurringJournalHistory,
  updateRecurringJournal,
  upsertRecurringJournalFromVoucher,
} from "../../services/accounting/recurringJournalService";

function positiveId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendRecurringError(res: Response, error: unknown): void {
  if (error instanceof RecurringJournalError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return;
  }
  res.status(500).json({ message: getErrorMessage(error) });
}

function currentCompanyId(req: Request): number | null {
  const id = Number(req.session.currentCompanyId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function registerRecurringJournalRoutes(app: Express): void {
  app.get("/api/recurring-journals/by-voucher/:voucherId", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = currentCompanyId(req);
    const voucherId = positiveId(req.params.voucherId);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    if (!voucherId) return res.status(400).json({ message: "Invalid voucher id" });

    try {
      return res.json(await getRecurringJournalForSource(companyId, voucherId));
    } catch (error: unknown) {
      sendRecurringError(res, error);
    }
  });

  app.post("/api/recurring-journals/from-voucher/:voucherId", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = currentCompanyId(req);
    const voucherId = positiveId(req.params.voucherId);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    if (!voucherId) return res.status(400).json({ message: "Invalid voucher id" });

    try {
      const recurring = await upsertRecurringJournalFromVoucher({
        companyId,
        sourceVoucherId: voucherId,
        userId: req.session.userId ?? null,
        timezone: req.body?.timezone,
        endDate: req.body?.endDate,
        descriptionTemplate: req.body?.descriptionTemplate,
      });
      const history = await getRecurringJournalHistory(companyId, recurring.id);
      return res.json({ recurring, history });
    } catch (error: unknown) {
      sendRecurringError(res, error);
    }
  });

  app.patch("/api/recurring-journals/:id", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = currentCompanyId(req);
    const recurringId = positiveId(req.params.id);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    if (!recurringId) return res.status(400).json({ message: "Invalid recurring journal id" });

    try {
      const recurring = await updateRecurringJournal(companyId, recurringId, {
        active: typeof req.body?.active === "boolean" ? req.body.active : undefined,
        timezone: req.body?.timezone,
        endDate: req.body?.endDate,
        descriptionTemplate: req.body?.descriptionTemplate,
      });
      const history = await getRecurringJournalHistory(companyId, recurring.id);
      return res.json({ recurring, history });
    } catch (error: unknown) {
      sendRecurringError(res, error);
    }
  });

  app.get("/api/recurring-journals/:id/history", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = currentCompanyId(req);
    const recurringId = positiveId(req.params.id);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    if (!recurringId) return res.status(400).json({ message: "Invalid recurring journal id" });

    try {
      return res.json({ history: await getRecurringJournalHistory(companyId, recurringId) });
    } catch (error: unknown) {
      sendRecurringError(res, error);
    }
  });
}
