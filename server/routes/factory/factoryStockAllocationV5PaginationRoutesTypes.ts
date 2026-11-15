// Extracted from ./factoryStockAllocationV5PaginationRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { parsePositiveInt } from "../../lib/listPagination";

const DEFAULT_PAGE_SIZE = 50;

const MAX_PAGE_SIZE = 250;

export const ACTIVE_ORDER_STATUSES = ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];

export function wantsPagination(req: Request): boolean {
  return (
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

export function parsePagination(req: Request): { page: number; limit: number; offset: number } {
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE));
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

export function queryText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface PageRow {
  articleCode: string;
  productName: string;
  categoryName: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
  totalKg: number;
  isGarbageOrWipers: boolean;
  proformaDetails: ProformaDetail[];
}

interface ContainerDetail {
  orderId: number;
  containerName: string;
  status: string;
  expectedQty: number;
  loadedQty: number;
  remainingQty: number;
}

export interface ProformaDetail {
  proformaId: number;
  proformaName: string;
  customerId: number;
  customerName: string;
  lineQty: number;
  containerCount: number;
  totalExpected: number;
  containers: ContainerDetail[];
}
