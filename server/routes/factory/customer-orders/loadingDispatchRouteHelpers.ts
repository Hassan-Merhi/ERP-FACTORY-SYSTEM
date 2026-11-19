// Extracted from ./loadingDispatchRoutes.ts to share request validation and order scoping.
import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";

export function parseOptionalText(raw: unknown, field: string, maxLength: number): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error(`${field} must be text`);
  const value = raw.trim();
  if (value.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return value || null;
}

export function parseTripNumber(raw: unknown): number {
  const textValue = typeof raw === "number" ? String(raw) : raw;
  if (typeof textValue !== "string" || !/^[1-9][0-9]*$/.test(textValue.trim())) {
    throw new Error("Trip number must be a positive whole number");
  }
  const number = Number(textValue.trim());
  if (!Number.isSafeInteger(number) || number > 2147483647) {
    throw new Error("Trip number must be between 1 and 2147483647");
  }
  return number;
}

export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

export async function resolveOrder(req: Request, res: Response) {
  const state = await getFactoryAccessState(req);
  if (!state) {
    res.status(403).json({ message: "Factory company access is unavailable" });
    return null;
  }

  const orderId = parseId(req.params.id);
  if (orderId === null) {
    res.status(400).json({ message: "Invalid loading order ID" });
    return null;
  }

  const result = await db.execute(sql`
    SELECT id, status, container_number AS "containerNumber",
           customer_id AS "customerId", proforma_id_used AS "proformaIdUsed",
           deleted_at AS "deletedAt"
      FROM customer_orders
     WHERE id = ${orderId} AND company_id = ${state.companyId}
     LIMIT 1
  `);
  const order = resultRows(result)[0];
  if (!order) {
    res.status(404).json({ message: "Loading order not found in this company" });
    return null;
  }
  return { state, orderId, order };
}
