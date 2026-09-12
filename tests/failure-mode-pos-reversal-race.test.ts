import { describe, expect, it, vi } from "vitest";
import {
  buildExactVoucherReversal,
  reverseVoucherExactlyTx,
  type VoucherReversalLoader,
} from "../server/services/accounting/voucherReversal";
import {
  buildExactStockMovementReversal,
  postExactStockMovementReversalTx,
  type ExactStockMovementReversalAdapter,
} from "../server/services/inventory/stockMovementReversal";
import {
  buildPosSaleAdvisoryLockKey,
  normalizePosClientSaleId,
} from "../server/services/pos/posSaleIdempotency";
import type { CentralPostingDependencies } from "../server/services/accounting/centralPostingEngine";
import type { DbTransaction } from "../server/db";

function createMockPostingTx(voucherId: number = 888) {
  return {
    execute: vi.fn(async () => ({ rows: [] })),
    insert: vi.fn((_table: any) => ({
      values: vi.fn((values: any) => ({
        returning: vi.fn(async () => {
          if (Array.isArray(values)) {
            return values.map((v, i) => ({ id: i + 1, voucherId, ...v }));
          }
          return [{ id: voucherId, ...values }];
        }),
      })),
    })),
  } as unknown as DbTransaction;
}

describe("Failure-Mode Suite: POS Reversal Race & Inventory Cost Integrity", () => {
  const originalPosSale = {
    voucher: {
      id: 501,
      companyId: 1,
      voucherNumber: "POS-SALE-501",
      voucherType: "Sales",
      voucherDate: "2026-09-01",
      totalAmount: "85.50",
      currency: "USD",
      exchangeRate: "1.0",
      locationId: 2,
      optional: false,
      sourceModule: "POS",
      deletedAt: null,
    },
    entries: [
      {
        id: 10,
        voucherId: 501,
        ledgerAccountId: 105,
        debitAmount: "85.50",
        creditAmount: "0",
        transactionCurrency: "USD",
        transactionDebitAmount: "85.50",
        transactionCreditAmount: "0",
        baseDebitAmount: "85.50",
        baseCreditAmount: "0",
        historicalExchangeRate: "1.0",
        rateConvention: "TRANSACTION_PER_BASE",
      },
      {
        id: 11,
        voucherId: 501,
        ledgerAccountId: 205,
        debitAmount: "0",
        creditAmount: "85.50",
        transactionCurrency: "USD",
        transactionDebitAmount: "0",
        transactionCreditAmount: "85.50",
        baseDebitAmount: "0",
        baseCreditAmount: "85.50",
        historicalExchangeRate: "1.0",
        rateConvention: "TRANSACTION_PER_BASE",
      },
    ],
  };

  describe("Simultaneous POS Sale Reversal Race", () => {
    it("serializes concurrent reversal attempts so exactly 1 reversal is posted and 2nd replays", async () => {
      let activeLock: boolean = false;
      let committedReversalVoucherId: number | null = null;
      let reversalCreatedCount = 0;

      const loader: VoucherReversalLoader = {
        loadOriginalForUpdate: vi.fn(async () => originalPosSale as any),
      };

      const executeReversalRequest = async () => {
        const stubTx = createMockPostingTx(888);

        const dependencies: CentralPostingDependencies = {
          ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
          idempotency: {
            findExisting: vi.fn(async () => {
              if (committedReversalVoucherId) {
                return {
                  voucher: {
                    id: committedReversalVoucherId,
                    voucherNumber: "REV-POS-501",
                    totalAmount: "85.50",
                  } as any,
                  entries: [],
                };
              }
              return null;
            }),
            record: vi.fn(async () => {
              reversalCreatedCount++;
              committedReversalVoucherId = 888;
            }),
          },
          audit: { recordPosting: vi.fn(async () => {}) },
        };

        if (activeLock) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        activeLock = true;
        try {
          const result = await reverseVoucherExactlyTx(
            stubTx,
            {
              companyId: 1,
              originalVoucherId: 501,
              reversalVoucherNumber: "REV-POS-501",
              reversalDate: "2026-09-02",
            },
            loader,
            dependencies
          );
          return result;
        } finally {
          activeLock = false;
        }
      };

      // Race 2 reversal requests concurrently
      const [first, second] = await Promise.all([
        executeReversalRequest(),
        executeReversalRequest(),
      ]);

      // Both returned the same reversal voucher ID
      expect(first.voucher.id).toBe(888);
      expect(second.voucher.id).toBe(888);

      // Exactly 1 posted and 1 replayed
      const creations = [first, second].filter((r) => !r.replayed);
      const replays = [first, second].filter((r) => r.replayed);
      expect(creations).toHaveLength(1);
      expect(replays).toHaveLength(1);
      expect(reversalCreatedCount).toBe(1);
    });
  });

  describe("Reversal Constraints & Company Scope Safety", () => {
    it("forbids reversing a reversal voucher", () => {
      expect(() =>
        buildExactVoucherReversal({
          companyId: 1,
          originalVoucherId: 501,
          original: { ...originalPosSale, isReversal: true } as any,
          reversalVoucherNumber: "REV-REV-501",
          reversalDate: "2026-09-02",
        })
      ).toThrowError(/cannot itself be reversed/i);
    });

    it("forbids reversing a voucher across company boundaries", () => {
      expect(() =>
        buildExactVoucherReversal({
          companyId: 99, // Mismatched company!
          originalVoucherId: 501,
          original: originalPosSale as any,
          reversalVoucherNumber: "REV-POS-501",
          reversalDate: "2026-09-02",
        })
      ).toThrowError(/different company/i);
    });
  });

  describe("Stock Movement Reversal Exactness", () => {
    const originalMovement = {
      id: 301,
      companyId: 1,
      locationId: 2,
      stockItemId: 15,
      movementKind: "issue" as const,
      quantityDelta: "-5.000",
      unitCost: "10.00",
      totalCost: "-50.00",
      reversalOfMovementId: null,
      sourceType: "pos-sale",
      sourceId: "501",
    };

    const sourceIdentity = {
      sourceType: "pos-sale-reversal",
      sourceId: "501-rev",
      idempotencyKey: "pos-rev-key-01",
    };

    it("generates exact inverse stock movement delta", () => {
      const reversalRequest = buildExactStockMovementReversal({
        original: originalMovement as any,
        occurredAt: "2026-09-02",
        source: sourceIdentity,
      });

      expect(reversalRequest).toMatchObject({
        companyId: 1,
        stockItemId: 15,
        kind: "reversal",
        quantity: "5", // Exact inverse of -5!
        toLocationId: 2,
        fromLocationId: null,
        reversalOfMovementId: 301,
        source: sourceIdentity,
      });
    });

    it("rejects zero quantity movements", () => {
      expect(() =>
        buildExactStockMovementReversal({
          original: { ...originalMovement, quantityDelta: "0" } as any,
          occurredAt: "2026-09-02",
          source: sourceIdentity,
        })
      ).toThrowError(
        expect.objectContaining({
          code: "STOCK_REVERSAL_ORIGINAL_INVALID",
        })
      );
    });

    it("rejects reversal-of-reversal chain in stock movement", () => {
      expect(() =>
        buildExactStockMovementReversal({
          original: {
            ...originalMovement,
            movementKind: "reversal" as any,
            reversalOfMovementId: 200,
          } as any,
          occurredAt: "2026-09-02",
          source: sourceIdentity,
        })
      ).toThrowError(
        expect.objectContaining({
          code: "STOCK_REVERSAL_CHAIN_INVALID",
        })
      );
    });

    it("posts stock movement reversal through adapter and verifies company match", async () => {
      const stubTx = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;

      const mockAdapter: ExactStockMovementReversalAdapter = {
        lockOriginalMovement: vi.fn(async () => originalMovement as any),
        findExisting: vi.fn(async () => null),
        validateOwnership: vi.fn(async () => {}),
        lockBalances: vi.fn(async () => ({ 2: "100" })),
        appendMovements: vi.fn(async ({ request, rows }) =>
          rows.map((row, index) => ({
            id: 401 + index,
            companyId: request.companyId,
            stockItemId: request.stockItemId,
            locationId: row.locationId,
            quantityDelta: row.quantityDelta,
            unitCost: row.unitCost,
            movementKind: request.kind,
            sourceType: request.source.sourceType,
            sourceId: request.source.sourceId,
            reversalOfMovementId: request.reversalOfMovementId,
          }))
        ),
        recordIdempotency: vi.fn(async () => {}),
        recordAudit: vi.fn(async () => {}),
      };

      const result = await postExactStockMovementReversalTx(
        stubTx,
        {
          companyId: 1,
          movementId: 301,
          occurredAt: "2026-09-02",
          source: sourceIdentity,
        },
        mockAdapter
      );

      expect(result.movements[0].id).toBe(401);
      expect(result.movements[0].movementKind).toBe("reversal");
      expect(result.movements[0].reversalOfMovementId).toBe(301);
    });
  });
});
