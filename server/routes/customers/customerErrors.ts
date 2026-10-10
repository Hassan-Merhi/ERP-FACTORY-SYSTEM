import type { Response } from "express";

import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { accountHistoryErrorResponse } from "../../services/accounting/accountHistoryPolicy";

export class CustomerRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "CustomerRouteError";
  }
}

export function sendCustomerRouteError(res: Response, error: unknown, fallbackStatus: number): Response {
  if (error instanceof CustomerRouteError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  // An account-history refusal (wave 16 B): opening, company or type change on an account with lines.
  const refused = accountHistoryErrorResponse(error);
  if (refused) return res.status(refused.status).json(refused.body);
  // A closed-period or opening-balance lock refusal from the database (wave 12).
  const closedPeriod = closedPeriodErrorResponse(error);
  if (closedPeriod) return res.status(closedPeriod.status).json(closedPeriod.body);
  const message = error instanceof Error ? error.message : String(error);
  return res.status(fallbackStatus).json({ message });
}
