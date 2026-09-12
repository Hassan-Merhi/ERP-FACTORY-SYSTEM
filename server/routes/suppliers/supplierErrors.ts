import type { Response } from "express";

export class SupplierRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "SupplierRouteError";
  }
}

export function sendSupplierRouteError(res: Response, error: unknown, fallbackStatus: number): Response {
  if (error instanceof SupplierRouteError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  const message = error instanceof Error ? error.message : String(error);
  return res.status(fallbackStatus).json({ message });
}
