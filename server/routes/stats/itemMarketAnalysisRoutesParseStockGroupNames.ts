// Extracted from ./itemMarketAnalysisRoutes.ts to keep that module under the source-size cap.
import { z } from "zod";
import { CompanyAccessError } from "../../security/companyAccessBoundary";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "Date is invalid");

export const querySchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  stockGroupId: z.coerce.number().int().positive().optional(),
  stockGroupName: z.string().trim().max(100).optional(),
  stockGroupNames: z.string().trim().max(2000).optional(),
  companyIds: z.string().trim().max(500).optional(),
});

export const exportSalePricesSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  companyItems: z
    .array(
      z.object({
        companyId: z.number().int().positive(),
        stockItemIds: z.array(z.number().int().positive()).min(1).max(5000),
      })
    )
    .min(1)
    .max(20),
});

export const salePriceQuerySchema = z.object({
  companyId: z.coerce.number().int().positive(),
  stockItemId: z.coerce.number().int().positive(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

export const first = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value[0] == null
      ? undefined
      : String(value[0])
    : typeof value === "string"
      ? value
      : undefined;

export function parseCompanyIds(value: string | undefined, activeCompanyId: number): number[] {
  if (!value) return [activeCompanyId];

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = [...new Set(parts.map((part) => Number(part)))];

  if (ids.length === 0 || ids.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new CompanyAccessError(400, "companyIds must contain 1 to 20 valid company IDs", "INVALID_COMPANY_IDS");
  }

  return ids;
}

export function parseStockGroupNames(value: string | undefined): string[] | undefined {
  if (!value) return undefined;

  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  if (names.length === 0) return undefined;
  if (names.length > 50 || names.some((name) => name.length > 100)) {
    throw new CompanyAccessError(
      400,
      "stockGroupNames must contain 1 to 50 valid stock group names",
      "INVALID_STOCK_GROUP_NAMES"
    );
  }

  return names;
}

export function marginPct(profit: number, revenue: number): number {
  return revenue === 0 ? 0 : Number(((profit / revenue) * 100).toFixed(2));
}
