import type { Response } from "express";

export type ListPagination = {
  requested: boolean;
  page: number;
  pageSize: number;
  offset: number;
};

type PaginationOptions = {
  defaultPageSize?: number;
  maxPageSize?: number;
  force?: boolean;
};

/** A positive integer parsed from a query value, or `fallback`. */
export function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseListPagination(query: Record<string, unknown>, options: PaginationOptions = {}): ListPagination {
  const defaultPageSize = Math.max(1, options.defaultPageSize ?? 100);
  const maxPageSize = Math.max(defaultPageSize, options.maxPageSize ?? 250);
  const requested =
    options.force === true ||
    query.pagination === "1" ||
    query.page !== undefined ||
    query.limit !== undefined ||
    query.pageSize !== undefined ||
    query.offset !== undefined;
  const pageSize = Math.min(parsePositiveInt(query.pageSize ?? query.limit, defaultPageSize), maxPageSize);
  const explicitOffset =
    query.offset === undefined ? null : Math.max(0, Number.parseInt(String(query.offset), 10) || 0);
  const page = explicitOffset === null ? parsePositiveInt(query.page, 1) : Math.floor(explicitOffset / pageSize) + 1;
  return {
    requested,
    page,
    pageSize,
    offset: explicitOffset ?? (page - 1) * pageSize,
  };
}

export function setListPaginationHeaders(res: Response, total: number, pagination: ListPagination): void {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pagination.pageSize);
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(pagination.page));
  res.setHeader("X-Page-Size", String(pagination.pageSize));
  res.setHeader("X-Total-Pages", String(totalPages));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");
}
