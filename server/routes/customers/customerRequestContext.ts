import type { Request } from "express";

import { requestRole } from "../../services/accounting/accountHistoryPolicy";

import { CustomerRouteError } from "./customerErrors";

export interface CustomerAuditActor {
  userId: string;
  username: string;
  /** The acting role, for the account-history rules (wave 16 B). */
  role?: string | null;
}

export function getActiveCustomerCompanyId(req: Request): number {
  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new CustomerRouteError(400, "No company selected");
  }
  return companyId;
}

export function parseCustomerId(value: string): number {
  const customerId = Number.parseInt(value, 10);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new CustomerRouteError(400, "Invalid customer ID");
  }
  return customerId;
}

export function getCustomerAuditActor(req: Request): CustomerAuditActor {
  return {
    userId: req.session.userId!,
    username: req.session.username || "unknown",
    role: requestRole(req),
  };
}
