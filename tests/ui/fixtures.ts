/**
 * Builders for the records page tests most often feed through `fakeApi`.
 *
 * Each returns the JSON shape the API sends (Date columns as ISO strings) and is
 * typed against the Drizzle row type in shared/schema. `npm run check` does not
 * cover tests/, so fixtures.test.ts also compares every builder's keys with its
 * table's columns: a column added, removed or renamed there fails the frontend
 * suite instead of leaving fixtures that quietly describe an older schema. Ids
 * count up per builder and restart with `resetFixtureIds()`; pass overrides for
 * whatever the test is about.
 */
import type { Company, Customer, Location, StockItem, Supplier } from "@shared/schema";

/** A row as it arrives over JSON: Date columns become ISO strings. */
export type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

const CREATED_AT = "2026-01-15T09:00:00.000Z";
const counters = new Map<string, number>();

function nextId(kind: string): number {
  const id = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, id);
  return id;
}

export function resetFixtureIds(): void {
  counters.clear();
}

export function buildCompany(overrides: Partial<Wire<Company>> = {}): Wire<Company> {
  const id = overrides.id ?? nextId("company");
  return {
    id,
    code: `C${id}`,
    name: `Test Company ${id}`,
    companyType: "erp",
    parentCompanyId: null,
    active: true,
    baseCurrency: "USD",
    displayCurrency: null,
    createdAt: CREATED_AT,
    transferWaGroupChatId: null,
    ...overrides,
  };
}

export function buildLocation(overrides: Partial<Wire<Location>> = {}): Wire<Location> {
  const id = overrides.id ?? nextId("location");
  return {
    id,
    companyId: 1,
    code: `L${id}`,
    name: `Warehouse ${id}`,
    city: null,
    state: null,
    country: null,
    active: true,
    deletedAt: null,
    createdAt: CREATED_AT,
    whatsappGroupChatId: null,
    transferWaGroupChatId: null,
    supplierPartnerPayableDeductionPerQty: "0",
    ...overrides,
  };
}

export function buildStockItem(overrides: Partial<Wire<StockItem>> = {}): Wire<StockItem> {
  const id = overrides.id ?? nextId("stockItem");
  return {
    id,
    companyId: 1,
    code: `SKU-${id}`,
    name: `Stock Item ${id}`,
    stockGroupId: null,
    gradeId: null,
    categoryId: null,
    uom: "PCS",
    openingQty: "0",
    openingRate: "0",
    openingValue: "0",
    reorderLevel: null,
    sellingPrice: null,
    active: true,
    deletedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

export function buildCustomer(overrides: Partial<Wire<Customer>> = {}): Wire<Customer> {
  const id = overrides.id ?? nextId("customer");
  return {
    id,
    companyId: 1,
    ledgerAccountId: null,
    code: `CUST-${id}`,
    legalName: `Customer ${id}`,
    phone: null,
    openingBalance: "0",
    openingBalanceSide: null,
    active: true,
    statementNote: null,
    paymentTermsDays: null,
    deletedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

export function buildSupplier(overrides: Partial<Wire<Supplier>> = {}): Wire<Supplier> {
  const id = overrides.id ?? nextId("supplier");
  return {
    id,
    code: `SUP-${id}`,
    legalName: `Supplier ${id}`,
    email: `supplier${id}@example.test`,
    phone: null,
    address: null,
    taxId: null,
    paymentTerms: null,
    openingBalance: "0",
    active: true,
    deletedAt: null,
    createdAt: CREATED_AT,
    stockGroupId: null,
    ...overrides,
  };
}
