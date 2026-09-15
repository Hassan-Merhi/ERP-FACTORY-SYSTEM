import type { Express, Request, Response, RequestHandler } from "express";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage, sendHttpError, translateDatabaseError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { checkFactoryAdmin } from "../factory/_helpers";
import { logAudit } from "../helpers/auditHelpers";
import { generateFactoryPayrollBatch } from "../../services/payroll/factoryPayrollGenerationService";

function statusForGenerationError(error: unknown): number {
  const message = getErrorMessage(error);
  if (/required|invalid|YYYY-MM-DD|cannot be after|No active workers/i.test(message)) {
    return 400;
  }
  return 500;
}

/**
 * Registered before the legacy factory payroll module.
 *
 * This route preserves the existing response shape (an array of payroll rows)
 * while owning generation in one transaction. The older route remains as a
 * compatibility fallback in source but is shadowed by registration order.
 */
export function registerCentralFactoryPayrollGenerationRoute(app: Express, requireAuth: RequestHandler): void {
  app.post("/api/factory/payroll/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;

      const companyId = Number(req.body?.companyId);
      const startDate = String(req.body?.startDate ?? "");
      const endDate = String(req.body?.endDate ?? "");
      const result = await generateFactoryPayrollBatch({
        companyId,
        startDate,
        endDate,
        txDate: getClientDate(req),
        createdBy: req.session?.userId ? String(req.session.userId) : null,
      });

      if (result.replayed) res.setHeader("X-Idempotent-Replay", "true");

      if (result.createdCount > 0) {
        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "create",
            tableName: "factory_payrolls",
            recordId: null,
            recordIdentifier: `Payroll generated — ${result.createdCount} worker(s), ${startDate} to ${endDate}`,
            changes: {
              atomicBatch: { old: false, new: true },
              createdCount: { old: 0, new: result.createdCount },
            },
          });
        } catch (auditError) {
          logger.error("[central payroll generate audit] non-fatal", { error: auditError });
        }
      }

      res.json(result.payrolls);
    } catch (error: unknown) {
      if (translateDatabaseError(error)) {
        sendHttpError(res, error);
        return;
      }

      const status = statusForGenerationError(error);
      if (status === 500) logger.error("Atomic payroll generation failed", { error });
      res.status(status).json({ message: getErrorMessage(error) });
    }
  });
}
