/**
 * Helpers for the factory bale product create/edit routes (productWriteRoutes).
 */
import { and, eq, sql } from "drizzle-orm";
import { factoryBaleProducts } from "@shared/schema";
import { db } from "../../../db";

/**
 * Highest numeric suffix among this company's article codes that start with
 * `prefix` (HMD11001 -> 1 for HMD11), or 0 when there is none. The start
 * position is cast to int: an untyped parameter made SUBSTRING take its
 * regular-expression form, so the query always answered 0 and new codes
 * filled gaps from 1 instead of following the highest code.
 */
export async function highestArticleNumber(companyId: number, prefix: string): Promise<number> {
  const start = prefix.length + 1;
  const suffix = sql`SUBSTRING(${factoryBaleProducts.articleCode} FROM ${start}::int)`;
  const [row] = await db
    .select({ maxNum: sql<number | string | null>`MAX(CAST(${suffix} AS INTEGER))` })
    .from(factoryBaleProducts)
    .where(
      and(
        eq(factoryBaleProducts.companyId, companyId),
        sql`${factoryBaleProducts.articleCode} LIKE ${prefix + "%"}`,
        sql`${suffix} ~ '^[0-9]{1,9}$'`
      )
    );
  return Number(row?.maxNum ?? 0) || 0;
}

/** The product fields an edit may change. Ownership, ids and timestamps are not among them. */
const EDITABLE_PRODUCT_FIELDS = [
  "code",
  "articleCode",
  "name",
  "nameAr",
  "description",
  "descriptionAr",
  "weightPerBaleKg",
  "categoryId",
  "sellingPrice",
  "productionPrice",
  "labelDesignColor",
  "active",
] as const satisfies ReadonlyArray<keyof typeof factoryBaleProducts.$inferInsert>;

type EditableProductField = (typeof EDITABLE_PRODUCT_FIELDS)[number];

/** Split an edit body into the editable fields and the names of any others. */
export function pickEditableProductFields(body: unknown): {
  fields: Partial<Pick<typeof factoryBaleProducts.$inferInsert, EditableProductField>>;
  rejected: string[];
} {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const allowed = new Set<string>(EDITABLE_PRODUCT_FIELDS);
  const fields: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) fields[key] = value;
    else rejected.push(key);
  }
  return { fields: fields as Partial<Pick<typeof factoryBaleProducts.$inferInsert, EditableProductField>>, rejected };
}

function databaseErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Client-facing status and message for a failed product write. Database
 * failures never echo the SQL text or its parameters; the route logs the
 * detail instead.
 */
export function productWriteFailure(error: unknown): { status: number; body: { message: string; code: string } } {
  switch (databaseErrorCode(error)) {
    case "23505":
      return {
        status: 409,
        body: { message: "A product with this code or article code already exists", code: "PRODUCT_CODE_TAKEN" },
      };
    case "23503":
      return {
        status: 400,
        body: { message: "The selected category does not exist", code: "PRODUCT_REFERENCE_MISSING" },
      };
    case "23502":
    case "23514":
    case "22001":
    case "22003":
    case "22P02":
      return { status: 400, body: { message: "One or more product fields are invalid", code: "PRODUCT_INVALID" } };
    default:
      return { status: 500, body: { message: "The product could not be saved", code: "PRODUCT_SAVE_FAILED" } };
  }
}
