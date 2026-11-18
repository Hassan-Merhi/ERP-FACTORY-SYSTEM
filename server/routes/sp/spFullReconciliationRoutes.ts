import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";
import { buildFullReconciliation } from "./buildFullReconciliation";

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function registerSpFullReconciliationRoutes(app: Express): void {
  app.get(
    "/api/sp/reconciliation/full",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        res.json(await buildFullReconciliation(companyId));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/sp/reconciliation/full/export.csv",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        const report = await buildFullReconciliation(companyId);
        const csv = [
          ["surface", "database_value", "independent_value", "status", "evidence_status", "basis", "detail"].join(","),
          ...report.surfaces.map((surface) =>
            [
              surface.key,
              surface.databaseValue,
              surface.reportValue,
              surface.pass ? "PASS" : "FAIL",
              surface.evidenceStatus ?? "",
              surface.basis,
              surface.detail ?? "",
            ]
              .map(csvEscape)
              .join(",")
          ),
        ].join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=sp-reconciliation-${companyId}.csv`);
        res.send(csv);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
