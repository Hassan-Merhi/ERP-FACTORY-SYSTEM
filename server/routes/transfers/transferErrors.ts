import type { Response } from "express";

import { getErrorMessage } from "../../lib/httpHandlers";

export class TransferRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TransferRouteError";
  }
}

export function sendTransferRouteError(res: Response, error: unknown, fallbackStatus: number): Response {
  const statusCode = error instanceof TransferRouteError ? error.statusCode : fallbackStatus;
  return res.status(statusCode).json({ message: getErrorMessage(error) });
}
