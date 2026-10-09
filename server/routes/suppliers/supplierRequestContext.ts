import type { Request } from "express";

import { requestRole } from "../../services/accounting/accountHistoryPolicy";

import { SupplierRouteError } from "./supplierErrors";

export interface SupplierAuditActor {
  userId: string;
  username: string;
  /** The acting role, for the account-history rules (wave 16 B). */
  role?: string | null;
}

export function getActiveSupplierCompanyId(req: Request): number {
  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new SupplierRouteError(400, "No company selected");
  }
  return companyId;
}

export function enforceSupplierCompanyQuery(req: Request, companyId: number): void {
  if (req.query.companyId == null) return;

  const requestedCompanyId = Number(req.query.companyId);
  if (!Number.isInteger(requestedCompanyId) || requestedCompanyId !== companyId) {
    throw new SupplierRouteError(403, "Supplier access is limited to the active company");
  }
}

export function parseSupplierId(value: string): number {
  const supplierId = Number.parseInt(value, 10);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw new SupplierRouteError(400, "Invalid supplier ID");
  }
  return supplierId;
}

export function getSupplierAuditActor(req: Request): SupplierAuditActor {
  return {
    userId: req.session.userId!,
    username: req.session.username || "unknown",
    role: requestRole(req),
  };
}
