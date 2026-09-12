import { describe, expect, it, vi } from "vitest";
import {
  findExistingStockDocumentTx,
  recordStockDocumentTx,
  resolveStockDocumentRequestId,
  stockDocumentIdempotencyKey,
  StockDocumentIdempotencyError,
  type StockDocumentIdempotencyTransaction,
} from "../server/services/inventory/stockDocumentIdempotency";
import {
  completeFinancialOperationTx,
  DurableFinancialOperationError,
  financialOperationFingerprint,
  reserveFinancialOperationTx,
  withDurableFinancialOperation,
  type DurableFinancialOperationInput,
} from "../server/services/accounting/durableFinancialOperation";
import {
  buildPosSaleAdvisoryLockKey,
  lockAndFindExistingPosSaleTx,
  normalizePosClientSaleId,
} from "../server/services/pos/posSaleIdempotency";
import {
  buildPostingRequestFingerprint,
  postBalancedVoucherTx,
  PostingValidationError,
  type CentralPostingDependencies,
  type CentralPostingRequest,
} from "../server/services/accounting/centralPostingEngine";
import {
  buildExactVoucherReversal,
  reverseVoucherExactlyTx,
  type VoucherReversalLoader,
} from "../server/services/accounting/voucherReversal";
import {
  buildSpOffloadChargeSignature,
  buildSpOffloadLockScope,
  classifySpOffloadState,
  isCompatibleSpOffloadReplay,
} from "../server/services/sp/spOffloadConcurrencyPolicy";
import type { DbTransaction } from "../server/db";

describe("Failure-Mode Suite: Double-Submit & Idempotency", () => {
  describe("Stock Document Request Identity & Double Submit", () => {
    it("validates and normalizes clientRequestId bounds", () => {
      expect(resolveStockDocumentRequestId(undefined)).toBeNull();
      expect(resolveStockDocumentRequestId(null)).toBeNull();
      expect(resolveStockDocumentRequestId("")).toBeNull();
      expect(resolveStockDocumentRequestId("   ")).toBeNull();
      expect(resolveStockDocumentRequestId(12345)).toBeNull();
      expect(resolveStockDocumentRequestId("  req-abc-123  ")).toBe("req-abc-123");

      expect(() => resolveStockDocumentRequestId("x".repeat(201))).toThrowError(
        expect.objectContaining({
          name: "StockDocumentIdempotencyError",
          code: "STOCK_DOCUMENT_REQUEST_ID_INVALID",
        })
      );
    });

    it("generates deterministic scoped idempotency keys", () => {
      const key1 = stockDocumentIdempotencyKey({
        sourceType: "stock-transfer",
        companyId: 5,
        clientRequestId: "req-99",
      });
      const key2 = stockDocumentIdempotencyKey({
        sourceType: "stock-transfer",
        companyId: 5,
        clientRequestId: "req-99",
      });
      const key3 = stockDocumentIdempotencyKey({
        sourceType: "stock-adjustment",
        companyId: 5,
        clientRequestId: "req-99",
      });
      const key4 = stockDocumentIdempotencyKey({
        sourceType: "stock-transfer",
        companyId: 6,
        clientRequestId: "req-99",
      });

      expect(key1).toBe("stock-transfer:5:req-99");
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).not.toBe(key4);
    });

    it("acquires advisory lock and retrieves existing document ID on double-submit", async () => {
      const executeQueries: string[] = [];
      const fakeTx = {
        execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
          executeQueries.push(String(query));
          return { rows: [] };
        }),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => [{ documentId: 42 }]),
              })),
            })),
          })),
        })),
      } as unknown as StockDocumentIdempotencyTransaction;

      const foundId = await findExistingStockDocumentTx({
        tx: fakeTx,
        companyId: 5,
        idempotencyKey: "stock-transfer:5:req-99",
      });

      expect(fakeTx.execute).toHaveBeenCalled();
      expect(foundId).toBe(42);
    });

    it("returns null when no existing document marker exists", async () => {
      const fakeTx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            })),
          })),
        })),
      } as unknown as StockDocumentIdempotencyTransaction;

      const foundId = await findExistingStockDocumentTx({
        tx: fakeTx,
        companyId: 5,
        idempotencyKey: "stock-transfer:5:req-fresh",
      });

      expect(foundId).toBeNull();
    });

    it("detects and rejects corrupt marker references", async () => {
      const fakeTx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => [{ documentId: "not-a-number" }]),
              })),
            })),
          })),
        })),
      } as unknown as StockDocumentIdempotencyTransaction;

      await expect(
        findExistingStockDocumentTx({
          tx: fakeTx,
          companyId: 5,
          idempotencyKey: "stock-transfer:5:req-corrupt",
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          name: "StockDocumentIdempotencyError",
          code: "STOCK_DOCUMENT_IDEMPOTENCY_CORRUPT",
        })
      );
    });

    it("records stock document marker inside the active transaction", async () => {
      const insertValues: unknown[] = [];
      const fakeTx = {
        insert: vi.fn(() => ({
          values: vi.fn(async (val: unknown) => {
            insertValues.push(val);
          }),
        })),
      } as unknown as StockDocumentIdempotencyTransaction;

      await recordStockDocumentTx({
        tx: fakeTx,
        companyId: 5,
        idempotencyKey: "stock-transfer:5:req-101",
        documentId: 88,
        sourceType: "stock-transfer",
        actorUserId: "user-42",
      });

      expect(fakeTx.insert).toHaveBeenCalled();
      expect(insertValues[0]).toMatchObject({
        companyId: 5,
        recordId: 88,
        recordIdentifier: "stock-transfer:5:req-101",
        action: "create",
        tableName: "stock_document_idempotency",
        userId: "user-42",
      });
    });
  });

  describe("Durable Financial Operation Double Submit", () => {
    const payload = { amount: "150.00", currency: "USD", accountId: 10 };
    const validFingerprint = financialOperationFingerprint(payload);

    const baseInput: DurableFinancialOperationInput = {
      companyId: 3,
      operationName: "vendor-payment",
      idempotencyKey: "pay-key-001",
      requestFingerprint: validFingerprint,
    };

    it("validates input constraints strictly", async () => {
      const fakeTx = { execute: vi.fn() } as unknown as DbTransaction;

      await expect(reserveFinancialOperationTx(fakeTx, { ...baseInput, companyId: 0 })).rejects.toThrowError(
        expect.objectContaining({ code: "FINANCIAL_OPERATION_COMPANY_INVALID" })
      );

      await expect(reserveFinancialOperationTx(fakeTx, { ...baseInput, operationName: "" })).rejects.toThrowError(
        expect.objectContaining({ code: "FINANCIAL_OPERATION_ID_REQUIRED" })
      );

      await expect(
        reserveFinancialOperationTx(fakeTx, { ...baseInput, requestFingerprint: "short" })
      ).rejects.toThrowError(expect.objectContaining({ code: "FINANCIAL_OPERATION_FINGERPRINT_INVALID" }));
    });

    it("grants ownership on first submission insert", async () => {
      const fakeTx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // lock
          .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }), // insert
      } as unknown as DbTransaction;

      const claim = await reserveFinancialOperationTx(fakeTx, baseInput);
      expect(claim.kind).toBe("owner");
      expect(claim.input.operationName).toBe("vendor-payment");
    });

    it("returns completed replay on double-submit with same fingerprint", async () => {
      const fakeTx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // insert on conflict
          .mockResolvedValueOnce({
            rows: [
              {
                operationName: "vendor-payment",
                requestFingerprint: validFingerprint,
                state: "completed",
                resultReference: "VOUCHER-777",
                resultStatus: 200,
                resultBody: { voucherId: 777, amount: "150.00" },
              },
            ],
            rowCount: 1,
          }),
      } as unknown as DbTransaction;

      const claim = await reserveFinancialOperationTx(fakeTx, baseInput);
      expect(claim.kind).toBe("replay");
      if (claim.kind === "replay") {
        expect(claim.stored.resultReference).toBe("VOUCHER-777");
        expect(claim.stored.resultBody).toEqual({ voucherId: 777, amount: "150.00" });
      }
    });

    it("rejects double-submit with modified financial payload for same key", async () => {
      const modifiedPayload = { amount: "999.00", currency: "USD", accountId: 10 };
      const modifiedFingerprint = financialOperationFingerprint(modifiedPayload);

      const fakeTx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // lock
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // insert conflict
          .mockResolvedValueOnce({
            rows: [
              {
                operationName: "vendor-payment",
                requestFingerprint: validFingerprint, // original fingerprint
                state: "completed",
                resultReference: "VOUCHER-777",
                resultStatus: 200,
                resultBody: { voucherId: 777 },
              },
            ],
            rowCount: 1,
          }),
      } as unknown as DbTransaction;

      await expect(
        reserveFinancialOperationTx(fakeTx, {
          ...baseInput,
          requestFingerprint: modifiedFingerprint,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          name: "DurableFinancialOperationError",
          code: "FINANCIAL_OPERATION_IDEMPOTENCY_CONFLICT",
        })
      );
    });

    it("completes operation and updates state inside transaction", async () => {
      const fakeTx = {
        execute: vi.fn().mockResolvedValueOnce({ rowCount: 1 }),
      } as unknown as DbTransaction;

      await completeFinancialOperationTx(fakeTx, baseInput, { voucherId: 888 }, "VOUCHER-888", 201);

      expect(fakeTx.execute).toHaveBeenCalled();
    });

    it("throws FINANCIAL_OPERATION_COMPLETION_FAILED if row was not updated", async () => {
      const fakeTx = {
        execute: vi.fn().mockResolvedValueOnce({ rowCount: 0 }),
      } as unknown as DbTransaction;

      await expect(completeFinancialOperationTx(fakeTx, baseInput, { voucherId: 888 })).rejects.toThrowError(
        expect.objectContaining({
          code: "FINANCIAL_OPERATION_COMPLETION_FAILED",
        })
      );
    });
  });

  describe("POS Sale Double Submit & Replay", () => {
    it("normalizes POS client sale identifiers", () => {
      expect(normalizePosClientSaleId(undefined)).toBeNull();
      expect(normalizePosClientSaleId(null)).toBeNull();
      expect(normalizePosClientSaleId("")).toBeNull();
      expect(normalizePosClientSaleId("pos-sale-42")).toBe("pos-sale-42");
      expect(normalizePosClientSaleId(42)).toBe("42");
    });

    it("builds distinct company-scoped lock keys", () => {
      const key1 = buildPosSaleAdvisoryLockKey(1, "sale-01");
      const key2 = buildPosSaleAdvisoryLockKey(1, "sale-01");
      const key3 = buildPosSaleAdvisoryLockKey(2, "sale-01");
      const key4 = buildPosSaleAdvisoryLockKey(1, "sale-02");

      expect(key1).toBe("pos-sale:1:sale-01");
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).not.toBe(key4);
    });

    it("returns existing voucher and items when sale was already committed", async () => {
      const existingVoucher = {
        id: 100,
        companyId: 1,
        clientSaleId: "sale-01",
        voucherType: "Sales",
        totalAmount: "50.00",
        deletedAt: null,
      };
      const existingItems = [{ id: 1, voucherId: 100, stockItemId: 10, quantity: "2" }];

      const fakeTx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(async () => [existingVoucher]),
              })),
            })),
          })
          .mockReturnValueOnce({
            from: vi.fn(() => ({
              where: vi.fn(async () => existingItems),
            })),
          }),
      } as unknown as DbTransaction;

      const result = await lockAndFindExistingPosSaleTx({
        tx: fakeTx,
        companyId: 1,
        clientSaleId: "sale-01",
      });

      expect(result).not.toBeNull();
      expect(result?.voucher.id).toBe(100);
      expect(result?.saleItems).toHaveLength(1);
    });

    it("returns null for unsaved sale id", async () => {
      const fakeTx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
          })),
        })),
      } as unknown as DbTransaction;

      const result = await lockAndFindExistingPosSaleTx({
        tx: fakeTx,
        companyId: 1,
        clientSaleId: "fresh-sale",
      });

      expect(result).toBeNull();
    });
  });

  describe("Central Accounting Posting Engine Double Submit", () => {
    const makeRequest = (overrides?: Partial<CentralPostingRequest["voucher"]>): CentralPostingRequest => ({
      voucher: {
        companyId: 2,
        voucherNumber: "JV-2026-001",
        voucherType: "Journal",
        voucherDate: "2026-09-01",
        totalAmount: "100.00",
        description: "Standard journal posting",
        currency: "USD",
        sourceModule: "ERP",
        ...overrides,
      },
      entries: [
        { ledgerAccountId: 10, debitAmount: "100.00", creditAmount: "0", narration: "Debit line" },
        { ledgerAccountId: 20, debitAmount: "0", creditAmount: "100.00", narration: "Credit line" },
      ],
      source: {
        sourceType: "manual-journal",
        sourceId: "journal-001",
        idempotencyKey: "journal-idempotency-key-001",
      },
    });

    it("fingerprints mathematically identical values consistently", () => {
      const r1 = makeRequest({ totalAmount: "100.00" });
      const r2 = makeRequest({ totalAmount: "100.0" });
      r2.entries[0].debitAmount = "100.0000";
      r2.entries[1].creditAmount = "100";

      expect(buildPostingRequestFingerprint(r1)).toBe(buildPostingRequestFingerprint(r2));
    });

    it("replays existing voucher without duplicate creation", async () => {
      const request = makeRequest();
      const existingVoucherWithEntries = {
        voucher: { id: 50, ...request.voucher, deletedAt: null } as any,
        entries: [{ id: 1, voucherId: 50, ...request.entries[0] }] as any,
      };

      const dependencies: CentralPostingDependencies = {
        ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
        idempotency: {
          findExisting: vi.fn(async () => existingVoucherWithEntries),
          record: vi.fn(async () => {}),
        },
        audit: { recordPosting: vi.fn(async () => {}) },
      };

      const stubTx = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;

      const result = await postBalancedVoucherTx(stubTx, request, dependencies);

      expect(result.replayed).toBe(true);
      expect(result.voucher.id).toBe(50);
      expect(dependencies.idempotency.record).not.toHaveBeenCalled();
      expect(dependencies.audit.recordPosting).not.toHaveBeenCalled();
    });

    it("rejects duplicate key submission when financial payload was modified", async () => {
      const request = makeRequest();
      const dependencies: CentralPostingDependencies = {
        ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
        idempotency: {
          findExisting: vi.fn(async () => {
            throw new PostingValidationError(
              "POSTING_IDEMPOTENCY_CONFLICT",
              "Posting key was already used for a different financial payload"
            );
          }),
          record: vi.fn(async () => {}),
        },
        audit: { recordPosting: vi.fn(async () => {}) },
      };

      const stubTx = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;

      await expect(postBalancedVoucherTx(stubTx, request, dependencies)).rejects.toThrowError(
        expect.objectContaining({
          code: "POSTING_IDEMPOTENCY_CONFLICT",
        })
      );
    });
  });

  describe("Exact Voucher Reversal Double Submit", () => {
    it("derives deterministic reversal idempotency key and prevents duplicate reversal", async () => {
      const originalVoucher = {
        voucher: {
          id: 55,
          companyId: 1,
          voucherNumber: "PMT-55",
          voucherType: "Payment",
          voucherDate: "2026-08-15",
          totalAmount: "50.00",
          currency: "USD",
          exchangeRate: "1.0",
          locationId: null,
          optional: false,
          sourceModule: "ERP",
          deletedAt: null,
        },
        entries: [
          {
            id: 1,
            voucherId: 55,
            ledgerAccountId: 10,
            debitAmount: "50.00",
            creditAmount: "0",
            transactionCurrency: "USD",
            transactionDebitAmount: "50.00",
            transactionCreditAmount: "0",
            baseDebitAmount: "50.00",
            baseCreditAmount: "0",
            historicalExchangeRate: "1.0",
            rateConvention: "TRANSACTION_PER_BASE",
          },
          {
            id: 2,
            voucherId: 55,
            bankAccountId: 3,
            debitAmount: "0",
            creditAmount: "50.00",
            transactionCurrency: "USD",
            transactionDebitAmount: "0",
            transactionCreditAmount: "50.00",
            baseDebitAmount: "0",
            baseCreditAmount: "50.00",
            historicalExchangeRate: "1.0",
            rateConvention: "TRANSACTION_PER_BASE",
          },
        ],
      };

      const loader: VoucherReversalLoader = {
        loadOriginalForUpdate: vi.fn(async () => originalVoucher as any),
      };

      const existingReversal = {
        voucher: { id: 99, voucherNumber: "REV-55", totalAmount: "50.00" } as any,
        entries: [],
      };

      const dependencies: CentralPostingDependencies = {
        ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
        idempotency: {
          findExisting: vi.fn(async () => existingReversal),
          record: vi.fn(async () => {}),
        },
        audit: { recordPosting: vi.fn(async () => {}) },
      };

      const stubTx = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;

      const result = await reverseVoucherExactlyTx(
        stubTx,
        {
          companyId: 1,
          originalVoucherId: 55,
          reversalVoucherNumber: "REV-55",
          reversalDate: "2026-08-16",
        },
        loader,
        dependencies
      );

      expect(result.replayed).toBe(true);
      expect(result.voucher.id).toBe(99);
      expect(dependencies.idempotency.findExisting).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 1,
          source: expect.objectContaining({
            sourceType: "voucher-reversal",
            sourceId: "55",
            idempotencyKey: "voucher-reversal:1:55",
          }),
        })
      );
    });
  });

  describe("SP Offload Double Submit & Replay Policy", () => {
    it("verifies SP offload lock scope and replay classification", () => {
      expect(buildSpOffloadLockScope(1, 10)).toEqual({ companyId: 1, containerId: 10 });

      const chargeSignature = buildSpOffloadChargeSignature([
        { chargeType: "paid_now", description: "Port clearance", amountUsd: "500.00", creditBankAccountId: 3 },
      ]);

      const existing = {
        offloadDate: "2026-09-01",
        locationId: 2,
        totalLandedCostUsd: 500.0,
        chargeSignature,
      };

      expect(classifySpOffloadState("open", false, false)).toBe("post");
      expect(classifySpOffloadState("offloaded", true, true)).toBe("replay");
      expect(classifySpOffloadState("offloaded", true, false)).toBe("conflict");
      expect(classifySpOffloadState("offloaded", false, false)).toBe("reject");
      expect(classifySpOffloadState(null, false, false)).toBe("reject");

      expect(isCompatibleSpOffloadReplay(existing, { ...existing, totalLandedCostUsd: 500.002 })).toBe(true);
      expect(isCompatibleSpOffloadReplay(existing, { ...existing, locationId: 3 })).toBe(false);
      expect(isCompatibleSpOffloadReplay(existing, { ...existing, offloadDate: "2026-09-02" })).toBe(false);
    });
  });
});
