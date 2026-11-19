import type { Express, Request, Response } from "express";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { z } from "zod";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import {
  emptyQuery,
  idParams,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";
import {
  RecurringJournalError,
  getRecurringJournalForSource,
  getRecurringJournalHistory,
  listRecurringJournals,
  updateRecurringJournal,
  upsertRecurringJournalFromVoucher,
  upsertRecurringJournalFromVoucherNumber,
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
  res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
}

function currentCompanyId(req: Request): number | null {
  const id = Number(req.session.currentCompanyId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const scheduleFields = {
  timezone: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  descriptionTemplate: z.string().nullable().optional(),
};

const fromVoucherNumberInput = {
  query: emptyQuery,
  body: z.strictObject({ voucherNumber: z.string().trim().min(1), ...scheduleFields }),
} satisfies RequestSchemas;

const fromVoucherInput = {
  params: z.strictObject({ voucherId: positiveIntParam }),
  query: emptyQuery,
  body: z.strictObject(scheduleFields),
} satisfies RequestSchemas;

const updateInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ active: z.boolean().optional(), ...scheduleFields }),
} satisfies RequestSchemas;

// Recurring journals are managed from ERP Settings, so API access intentionally matches the Admin/Developer Settings route.
export function registerRecurringJournalRoutes(app: Express): void {
  app.get(
    "/api/recurring-journals",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    async (req, res) => {
      const companyId = currentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      try {
        return res.json({ recurringJournals: await listRecurringJournals(companyId) });
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );

  app.post(
    "/api/recurring-journals/from-voucher-number",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    validateRequest(fromVoucherNumberInput),
    async (req, res) => {
      const companyId = currentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { body } = validatedInput(req, fromVoucherNumberInput);

      try {
        const recurring = await upsertRecurringJournalFromVoucherNumber({
          companyId,
          voucherNumber: body.voucherNumber,
          userId: req.session.userId ?? null,
          timezone: body.timezone,
          endDate: body.endDate,
          descriptionTemplate: body.descriptionTemplate,
        });
        const history = await getRecurringJournalHistory(companyId, recurring.id);
        return res.json({ recurring, history });
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );

  app.get(
    "/api/recurring-journals/by-voucher/:voucherId",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    async (req, res) => {
      const companyId = currentCompanyId(req);
      const voucherId = positiveId(req.params.voucherId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!voucherId) return res.status(400).json({ message: "Invalid voucher id" });

      try {
        return res.json(await getRecurringJournalForSource(companyId, voucherId));
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );

  app.post(
    "/api/recurring-journals/from-voucher/:voucherId",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    validateRequest(fromVoucherInput),
    async (req, res) => {
      const companyId = currentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { params, body } = validatedInput(req, fromVoucherInput);

      try {
        const recurring = await upsertRecurringJournalFromVoucher({
          companyId,
          sourceVoucherId: params.voucherId,
          userId: req.session.userId ?? null,
          timezone: body.timezone,
          endDate: body.endDate,
          descriptionTemplate: body.descriptionTemplate,
        });
        const history = await getRecurringJournalHistory(companyId, recurring.id);
        return res.json({ recurring, history });
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );

  app.patch(
    "/api/recurring-journals/:id",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    validateRequest(updateInput),
    async (req, res) => {
      const companyId = currentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { params, body } = validatedInput(req, updateInput);

      try {
        const recurring = await updateRecurringJournal(companyId, params.id, body);
        const history = await getRecurringJournalHistory(companyId, recurring.id);
        return res.json({ recurring, history });
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );

  app.get(
    "/api/recurring-journals/:id/history",
    requireAuth,
    requireRole("Admin", "Developer"),
    requireNonPOS,
    async (req, res) => {
      const companyId = currentCompanyId(req);
      const recurringId = positiveId(req.params.id);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!recurringId) return res.status(400).json({ message: "Invalid recurring journal id" });

      try {
        return res.json({ history: await getRecurringJournalHistory(companyId, recurringId) });
      } catch (error: unknown) {
        sendRecurringError(res, error);
      }
    }
  );
}
