// Extracted from ./adminPostUpdateStockTransferRevisionRoute.ts
import type { NextFunction, Request, Response } from "express";

/**
 * Drizzle's `db.execute` returns a driver result object on node-postgres and a
 * bare array on other drivers, so the row list lives in either shape. Narrowing
 * from `unknown` keeps the helper honest without an `any` escape.
 */
type QueryResultLike = { rows?: unknown } | readonly unknown[] | null | undefined;

export function rows<T = Record<string, unknown>>(result: QueryResultLike): T[] {
  if (Array.isArray(result)) return [...result] as T[];
  const carried = result && typeof result === "object" ? (result as { rows?: unknown }).rows : undefined;
  if (Array.isArray(carried)) return [...carried] as T[];
  return [];
}

export function firstRow<T = Record<string, unknown>>(result: QueryResultLike): T | undefined {
  return rows<T>(result)[0];
}

export function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

/**
 * Pending revisions belong to the canonical immutable lifecycle, which is the
 * route that accepts POS submissions and enforces the POS source-location
 * boundary. This compatibility route is registered first, so it must skip the
 * entire route before requireNonPOS runs. A plain next() would continue into
 * requireNonPOS and incorrectly reject every POS revision with a 403.
 */
export function bypassAdminCompatibilityForPendingRevision(req: Request, _res: Response, next: NextFunction) {
  if (req.body?.optional === true) return next("route");
  return next();
}
