import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  checkIdempotentSale: vi.fn(),
  resolvePosEnforcedCashAccount: vi.fn(),
  resolvePaymentAccount: vi.fn(),
  validateLocationAccess: vi.fn(),
  validateStockItemsExist: vi.fn(),
  validateItemsBasic: vi.fn(),
  calculateGrandTotal: vi.fn(),
  validateInventoryAvailability: vi.fn(),
  getOrCreateSalesRevenueAccount: vi.fn(),
  fetchSupplierPartnerAccountingContext: vi.fn(),
  insertSaleAccountingEntries: vi.fn(),
  insertSaleVoucher: vi.fn(),
  lockAndDeductInventoryForSaleItem: vi.fn(),
  lockAndFindExistingPosSaleTx: vi.fn(),
  getShiftById: vi.fn(),
  getLocationById: vi.fn(),
  logAudit: vi.fn(),
  runIntercompanyPosTransfer: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../server/services/pos/validateSaleRequest", () => ({
  checkIdempotentSale: harness.checkIdempotentSale,
  resolvePosEnforcedCashAccount: harness.resolvePosEnforcedCashAccount,
  resolvePaymentAccount: harness.resolvePaymentAccount,
  validateLocationAccess: harness.validateLocationAccess,
  validateStockItemsExist: harness.validateStockItemsExist,
}));
vi.mock("../server/services/pos/buildSaleItems", () => ({
  validateItemsBasic: harness.validateItemsBasic,
  calculateGrandTotal: harness.calculateGrandTotal,
  validateInventoryAvailability: harness.validateInventoryAvailability,
}));
vi.mock("../server/services/pos/postSaleAccounting", () => ({
  getOrCreateSalesRevenueAccount: harness.getOrCreateSalesRevenueAccount,
  fetchSupplierPartnerAccountingContext: harness.fetchSupplierPartnerAccountingContext,
  insertSaleAccountingEntries: harness.insertSaleAccountingEntries,
}));
vi.mock("../server/services/pos/createSaleVoucher", () => ({ insertSaleVoucher: harness.insertSaleVoucher }));
vi.mock("../server/services/pos/deductSaleInventory", () => ({
  lockAndDeductInventoryForSaleItem: harness.lockAndDeductInventoryForSaleItem,
}));
vi.mock("../server/services/pos/posSaleIdempotency", () => ({
  lockAndFindExistingPosSaleTx: harness.lockAndFindExistingPosSaleTx,
  // Mirrors the real module: the service reads this to bound the retry key
  // against the vouchers.client_sale_id column width.
  POS_CLIENT_SALE_ID_MAX_LENGTH: 36,
}));
vi.mock("../server/storage", () => ({
  storage: {
    getShiftById: harness.getShiftById,
    getLocationById: harness.getLocationById,
  },
}));
vi.mock("../server/routes/_helpers", () => ({
  logAudit: harness.logAudit,
  runIntercompanyPosTransfer: harness.runIntercompanyPosTransfer,
}));
vi.mock("../server/lib/logger", () => ({
  logger: { info: harness.loggerInfo, error: harness.loggerError },
}));
vi.mock("../server/db", () => ({ db: { transaction: harness.transaction } }));
vi.mock("../server/lib/inventoryMath", () => ({
  inventoryMoney: (value: unknown) => String(value),
  inventoryQuantity: (value: unknown) => String(value),
  inventoryUnitCost: (value: unknown) => String(value),
  multiplyInventoryValues: vi.fn(),
  subtractInventoryValues: vi.fn(),
  toInventoryDecimal: (value: unknown) => value,
}));
vi.mock("@shared/schema", () => ({
  stockItems: { id: "stockItems.id" },
  stockItemLocationPrices: { stockItemId: "prices.stockItemId", locationId: "prices.locationId" },
  salesItems: { name: "salesItems" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

const baseParams = {
  currentCompanyId: 4,
  userId: "user-1",
  username: "cashier",
  userRole: "POS",
  canSellNegativeStock: false,
  sessionCashAccountId: 12,
  voucherDateFallback: "2026-08-12",
};

async function loadCreatePosSale() {
  const module = await import("../server/services/pos/createSaleService");
  return module.createPosSale;
}

describe("POS create sale service validation and replay guards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    harness.resolvePosEnforcedCashAccount.mockResolvedValue({ posEnforcedCashAccountId: 12 });
    harness.resolvePaymentAccount.mockResolvedValue({
      accountType: "cash",
      accountId: 12,
      customerAccount: null,
    });
    harness.checkIdempotentSale.mockResolvedValue(null);
  });

  it("returns the POS cash-account enforcement error before resolving payment", async () => {
    const createPosSale = await loadCreatePosSale();
    harness.resolvePosEnforcedCashAccount.mockResolvedValue({
      error: { status: 403, body: { message: "Cash account is not assigned" } },
    });

    await expect(
      createPosSale(
        {
          ...baseParams,
          body: { locationId: 2, items: [{ stockItemId: 7, quantity: "1", rate: "3" }] },
        } as any,
        { isSpCompany: false }
      )
    ).resolves.toEqual({ status: 403, body: { message: "Cash account is not assigned" } });
    expect(harness.resolvePaymentAccount).not.toHaveBeenCalled();
  });

  it("returns a committed idempotent response before re-validating the request body", async () => {
    const createPosSale = await loadCreatePosSale();
    const committed = { status: 200, body: { voucher: { id: 90 }, _idempotent: true } };
    harness.checkIdempotentSale.mockResolvedValue(committed);

    await expect(
      createPosSale({ ...baseParams, body: { clientSaleId: "offline-123" } } as any, { isSpCompany: false })
    ).resolves.toBe(committed);
    expect(harness.checkIdempotentSale).toHaveBeenCalledWith(4, "offline-123");
  });

  it("rejects a missing location after account and replay checks", async () => {
    const createPosSale = await loadCreatePosSale();
    await expect(
      createPosSale({ ...baseParams, body: { items: [{ stockItemId: 7, quantity: "1", rate: "3" }] } } as any, {
        isSpCompany: false,
      })
    ).resolves.toEqual({ status: 400, body: { message: "Location is required" } });
  });

  it("drops a mismatched open shift before continuing item validation", async () => {
    const createPosSale = await loadCreatePosSale();
    harness.getShiftById.mockResolvedValue({
      id: 77,
      companyId: 99,
      locationId: 2,
      status: "open",
      userId: "user-1",
    });
    harness.validateItemsBasic.mockReturnValue({
      error: { status: 422, body: { message: "Invalid item quantity" } },
    });

    await expect(
      createPosSale(
        {
          ...baseParams,
          body: {
            locationId: 2,
            shiftId: 77,
            items: [{ stockItemId: 7, quantity: "0", rate: "3" }],
          },
        } as any,
        { isSpCompany: false }
      )
    ).resolves.toEqual({ status: 422, body: { message: "Invalid item quantity" } });
    expect(harness.getShiftById).toHaveBeenCalledWith(77);
    expect(harness.validateItemsBasic).toHaveBeenCalled();
  });
});
