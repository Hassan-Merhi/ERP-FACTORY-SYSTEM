import type { Response } from "express";

import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";

export class SupplierRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "SupplierRouteError";
  }
}

export function sendSupplierRouteError(res: Response, error: unknown, fallbackStatus: number): Response {
  if (error instanceof SupplierRouteError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  // A closed-period or opening-balance lock refusal from the database (wave 12).
  const closedPeriod = closedPeriodErrorResponse(error);
  if (closedPeriod) return res.status(closedPeriod.status).json(closedPeriod.body);
  const message = error instanceof Error ? error.message : String(error);
  return res.status(fallbackStatus).json({ message });
}
