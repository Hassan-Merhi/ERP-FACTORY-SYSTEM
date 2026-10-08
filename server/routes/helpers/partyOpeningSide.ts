import { pool } from "../../db";

export type OpeningSide = "Dr" | "Cr";

/**
 * suppliers.opening_balance_side and employees.opening_balance_side are
 * runtime-schema columns (server/startup/ensureRuntimeSchema.ts) that the
 * Drizzle models do not carry, so readers load them here. Both parties are
 * credit-normal: a missing side means Cr.
 */
export function partyOpeningSide(side: string | null | undefined): OpeningSide {
  return side === "Dr" ? "Dr" : "Cr";
}

const PARTY_TABLES = { suppliers: "suppliers", employees: "employees" } as const;

/** Opening sides by id for the given suppliers or employees (missing → Cr). */
export async function loadPartyOpeningSides(
  party: keyof typeof PARTY_TABLES,
  ids: readonly number[]
): Promise<Map<number, OpeningSide>> {
  const sides = new Map<number, OpeningSide>();
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return sides;
  const result = await pool.query<{ id: number; side: string | null }>(
    `SELECT id, opening_balance_side AS side FROM ${PARTY_TABLES[party]} WHERE id = ANY($1::int[])`,
    [unique]
  );
  for (const row of result.rows) sides.set(Number(row.id), partyOpeningSide(row.side));
  return sides;
}
