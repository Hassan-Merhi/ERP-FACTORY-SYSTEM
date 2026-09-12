export interface VoucherListQuery {
  startDate?: string;
  endDate?: string;
  type?: string;
  search?: string;
  status?: string;
  minAmount?: string;
  maxAmount?: string;
  sort?: string;
  profile?: string;
  page?: string;
  pageSize?: string;
}

export type ParsedVoucherListQuery = Omit<VoucherListQuery, "page" | "pageSize"> & {
  page: number;
  pageSize: number;
  paginated: boolean;
};

type VoucherFilterQuery = Pick<
  VoucherListQuery,
  "type" | "search" | "status" | "minAmount" | "maxAmount" | "sort"
>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isStrictDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseVoucherListQuery(raw: Record<string, unknown>):
  | { ok: true; query: ParsedVoucherListQuery }
  | { ok: false; message: string } {
  const startDate = raw.startDate == null ? undefined : String(raw.startDate);
  const endDate = raw.endDate == null ? undefined : String(raw.endDate);
  if (startDate && !isStrictDate(startDate)) return { ok: false, message: "Invalid startDate" };
  if (endDate && !isStrictDate(endDate)) return { ok: false, message: "Invalid endDate" };
  if (startDate && endDate && startDate > endDate) return { ok: false, message: "startDate must be before endDate" };

  const rawPage = Number.parseInt(String(raw.page ?? "1"), 10);
  const rawPageSize = Number.parseInt(String(raw.pageSize ?? "100"), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(200, Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : 100);
  const profile = raw.profile == null ? undefined : String(raw.profile);

  return {
    ok: true,
    query: {
      startDate,
      endDate,
      type: raw.type == null ? undefined : String(raw.type),
      search: raw.search == null ? undefined : String(raw.search),
      status: raw.status == null ? undefined : String(raw.status),
      minAmount: raw.minAmount == null ? undefined : String(raw.minAmount),
      maxAmount: raw.maxAmount == null ? undefined : String(raw.maxAmount),
      sort: raw.sort == null ? undefined : String(raw.sort),
      profile,
      page,
      pageSize,
      paginated: profile === "page" || raw.page != null || raw.pageSize != null,
    },
  };
}

export function filterAndSortVouchers<T extends Record<string, unknown>>(rows: T[], query: VoucherFilterQuery): T[] {
  const search = query.search?.trim().toLowerCase() ?? "";
  const minimum = query.minAmount ? Number.parseFloat(query.minAmount) : null;
  const maximum = query.maxAmount ? Number.parseFloat(query.maxAmount) : null;

  return rows
    .filter((row) => {
      if (query.type && query.type !== "all" && row.voucherType !== query.type) return false;
      if (query.status === "active" && row.optional) return false;
      if (query.status === "optional" && !row.optional) return false;
      const total = Number.parseFloat(String(row.totalAmount ?? "0")) || 0;
      if (minimum !== null && Number.isFinite(minimum) && total < minimum) return false;
      if (maximum !== null && Number.isFinite(maximum) && total > maximum) return false;
      if (search) {
        const values = [row.voucherNumber, row.description, row.locationName];
        if (!values.some((value) => String(value ?? "").toLowerCase().includes(search))) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const direction = query.sort === "asc" ? 1 : -1;
      const dateOrder = String(a.voucherDate ?? "").localeCompare(String(b.voucherDate ?? ""));
      if (dateOrder !== 0) return dateOrder * direction;
      return (Number(a.id) - Number(b.id)) * direction;
    });
}

export function toCompactVoucher(row: Record<string, unknown>) {
  return {
    id: row.id,
    voucherNumber: row.voucherNumber,
    voucherType: row.voucherType,
    voucherDate: row.voucherDate,
    description: row.description ?? null,
    totalAmount: row.totalAmount ?? "0",
    optional: row.optional === true,
    createdAt: row.createdAt,
    locationId: row.locationId ?? null,
    locationName: row.locationName ?? null,
    shiftId: row.shiftId ?? null,
    isCreditSale: row.isCreditSale === true,
  };
}

export function buildVoucherPage<T extends Record<string, unknown>>(rows: T[], page: number, pageSize: number) {
  const total = rows.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  return {
    data: rows.slice(offset, offset + pageSize).map(toCompactVoucher),
    page: safePage,
    pageSize,
    total,
    totalPages,
    hasMore: safePage < totalPages,
    summary: {
      total,
      active: rows.filter((row) => !row.optional).length,
      optional: rows.filter((row) => row.optional).length,
      totalAmount: rows.reduce((sum, row) => sum + (Number.parseFloat(String(row.totalAmount ?? "0")) || 0), 0),
    },
  };
}
