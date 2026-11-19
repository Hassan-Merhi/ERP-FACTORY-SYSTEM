// Extracted from ./loadingDispatchAllocationRoutes.ts to keep that module under the source-size cap.
import { requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { resultRows } from "../../../lib/queryResult";

export const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");

const MAX_LINES = 2000;

const MAX_BALES = 10000;

const MAX_RESERVE = 10000;

type Raw = Record<string, unknown>;

export function rows(value: unknown): Raw[] {
  return resultRows(value);
}

export function str(value: unknown): string {
  return value == null ? "" : String(value);
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function code(value: unknown): string {
  return str(value).trim().toUpperCase();
}

export function supervisor(role: string): boolean {
  return ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
}

function validId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export class PlanningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function fail(status: number, errorCode: string, message: string): never {
  throw new PlanningError(status, errorCode, message);
}

export type Loaded = {
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  orderIndex: number;
};

type PlanLine = { articleCode: string; expectedQty: number };

type Plan = { lines: PlanLine[]; baleIds: number[]; autoAssignBales: boolean };

export type Source = {
  trip: Raw;
  order: Raw;
  loaded: Loaded[];
  priority: Raw | null;
  existingArticles: Raw[];
  existingBales: Raw[];
  scans: Raw[];
  queueRanks: Map<string, number>;
};

export function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "INVALID_PLAN", "Provide a valid truck plan");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((k) => !["lines", "baleIds", "autoAssignBales"].includes(k))) {
    fail(400, "INVALID_PLAN", "Only lines, baleIds and autoAssignBales may be submitted");
  }
  if (!Array.isArray(input.lines) || input.lines.length > MAX_LINES)
    fail(400, "INVALID_LINES", "Provide at most 2,000 article target lines");
  const seen = new Set<string>();
  const lines: PlanLine[] = [];
  for (const rawLine of input.lines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine))
      fail(400, "INVALID_LINES", "Invalid article target");
    const line = rawLine as Record<string, unknown>;
    if (Object.keys(line).some((k) => !["articleCode", "expectedQty"].includes(k))) {
      fail(400, "INVALID_LINES", "Only articleCode and expectedQty are allowed in target lines");
    }
    const articleCode = code(line.articleCode);
    const expectedQty = line.expectedQty;
    if (
      !articleCode ||
      articleCode.length > 50 ||
      seen.has(articleCode) ||
      typeof expectedQty !== "number" ||
      !Number.isSafeInteger(expectedQty) ||
      expectedQty < 0 ||
      expectedQty > MAX_RESERVE
    ) {
      fail(400, "INVALID_LINES", "Article targets must use unique codes and whole nonnegative quantities");
    }
    seen.add(articleCode);
    if (expectedQty > 0) lines.push({ articleCode, expectedQty });
  }
  const ids = input.baleIds === undefined ? [] : input.baleIds;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_BALES ||
    ids.some((id) => !validId(id)) ||
    new Set(ids).size !== ids.length
  ) {
    fail(400, "INVALID_BALES", "Provide unique positive bale IDs (maximum 10,000)");
  }
  if (input.autoAssignBales !== undefined && typeof input.autoAssignBales !== "boolean") {
    fail(400, "INVALID_AUTO", "autoAssignBales must be true or false");
  }
  return { lines, baleIds: ids as number[], autoAssignBales: input.autoAssignBales === true };
}
