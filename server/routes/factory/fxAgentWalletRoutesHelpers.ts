// Extracted from ./fxAgentWalletRoutes.ts
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getClientDate } from "../../lib/dateUtils";
import { toMoney } from "../../lib/money";

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ROLES = ["Admin", "Owner", "Developer"] as const;

export function company(req: Request) {
  return Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
}

export function positive(value: unknown): string {
  const v = String(value ?? "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(v) || toMoney(v).lte(0)) throw new Error("Positive amount required (max 6 decimals)");
  return v;
}

export function rate(value: unknown): string {
  const v = String(value ?? "");
  if (!/^\d+(?:\.\d{1,10})?$/.test(v) || toMoney(v).lte(0)) throw new Error("Enter a positive USD-per-EUR rate");
  return v;
}

export function dateOf(req: Request): string {
  const date = String(req.body?.date ?? getClientDate(req));
  if (!DATE.test(date) || date > getClientDate(req)) throw new Error("Date must not be in the future");
  return date;
}

export async function configRate(cid: number, date: string) {
  const result = await db.execute(sql`
    SELECT rate_to_usd::text AS rate FROM factory_fx_rates
    WHERE company_id = ${cid} AND currency_code = 'EUR' AND source = 'manual'
      AND effective_date <= ${date}::date
    ORDER BY effective_date DESC, id DESC LIMIT 1`);
  return result.rows[0]?.rate ? String(result.rows[0].rate) : null;
}
