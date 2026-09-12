import type { Response } from "express";

export class CustomerRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CustomerRouteError";
  }
}

export function sendCustomerRouteError(res: Response, error: unknown, fallbackStatus: number): Response {
  if (error instanceof CustomerRouteError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(fallbackStatus).json({ message });
}
