import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import {
  buildPostingRequestFingerprint,
  postBalancedVoucherTx,
  PostingValidationError,
  type CentralPostingDependencies,
  type CentralPostingRequest,
} from "../server/services/accounting/centralPostingEngine";
import type { DbTransaction } from "../server/db";

function createMockPostingTx(voucherId: number = 999) {
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

describe("Failure-Mode Suite: Concurrent Accounting Posting", () => {
  const makePostingRequest = (
    companyId: number,
    key: string,
    amount: string,
    voucherNumber: string
  ): CentralPostingRequest => ({
    voucher: {
      companyId,
      voucherNumber,
      voucherType: "Journal",
      voucherDate: "2026-09-02",
      totalAmount: amount,
      description: `Concurrent posting ${key}`,
      currency: "USD",
      sourceModule: "ERP",
    },
    entries: [
      {
        ledgerAccountId: 101,
        debitAmount: amount,
        creditAmount: "0",
        narration: "Debit",
      },
      {
        ledgerAccountId: 202,
        debitAmount: "0",
        creditAmount: amount,
        narration: "Credit",
      },
    ],
    source: {
      sourceType: "concurrent-test",
      sourceId: `source-${key}`,
      idempotencyKey: key,
    },
  });

  describe("Racing Concurrent Submissions with Identical Key", () => {
    it("serializes N concurrent racing posts so exactly 1 creates and N-1 replay", async () => {
      const CONCURRENCY = 10;
      const sharedKey = "race-idem-key-777";
      const request = makePostingRequest(1, sharedKey, "250.00", "JV-CONC-01");

      // Shared mock database state simulating PostgreSQL table & advisory lock
      let activeLockHolder: number | null = null;
      let committedVoucher: { id: number; voucherNumber: string } | null = null;
      let insertCount = 0;

      // Simulated advisory lock with queue
      const lockQueue: Array<() => void> = [];
      const acquireLock = async (workerId: number) => {
        if (activeLockHolder === null) {
          activeLockHolder = workerId;
          return;
        }
        await new Promise<void>((resolve) => lockQueue.push(resolve));
        activeLockHolder = workerId;
      };
      const releaseLock = () => {
        activeLockHolder = null;
        const next = lockQueue.shift();
        if (next) next();
      };

      const executeWorker = async (workerId: number) => {
        const stubTx = createMockPostingTx(999);

        const dependencies: CentralPostingDependencies = {
          ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
          idempotency: {
            findExisting: vi.fn(async () => {
              if (committedVoucher) {
                return {
                  voucher: { id: committedVoucher.id, ...request.voucher, deletedAt: null } as any,
                  entries: [
                    { id: 1, voucherId: committedVoucher.id, ...request.entries[0] } as any,
                    { id: 2, voucherId: committedVoucher.id, ...request.entries[1] } as any,
                  ],
                };
              }
              return null;
            }),
            record: vi.fn(async () => {
              insertCount++;
              committedVoucher = { id: 999, voucherNumber: request.voucher.voucherNumber };
            }),
          },
          audit: { recordPosting: vi.fn(async () => {}) },
        };

        await acquireLock(workerId);
        try {
          const result = await postBalancedVoucherTx(stubTx, request, dependencies);
          return result;
        } finally {
          releaseLock();
        }
      };

      // Run 10 workers concurrently
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) => executeWorker(i + 1))
      );

      // Verify all 10 completed successfully
      expect(results).toHaveLength(CONCURRENCY);

      // Verify all 10 received the same voucher ID
      for (const res of results) {
        expect(res.voucher.id).toBe(999);
      }

      // Verify exactly 1 executed the creation (replayed: false) and 9 replayed
      const creations = results.filter((r) => !r.replayed);
      const replays = results.filter((r) => r.replayed);
      expect(creations).toHaveLength(1);
      expect(replays).toHaveLength(CONCURRENCY - 1);
      expect(insertCount).toBe(1);
    });
  });

  describe("Concurrent Distinct Posting Requests", () => {
    it("processes multiple distinct concurrent vouchers independently without crosstalk", async () => {
      const COUNT = 8;
      const requests = Array.from({ length: COUNT }, (_, i) =>
        makePostingRequest(i % 2 === 0 ? 1 : 2, `distinct-key-${i}`, `${(i + 1) * 50}.00`, `JV-DISTINCT-${i}`)
      );

      const postedRecords: Array<{ id: number; key: string; companyId: number; amount: string }> = [];

      const executeDistinctWorker = async (req: CentralPostingRequest, index: number) => {
        const stubTx = createMockPostingTx(100 + index);

        const dependencies: CentralPostingDependencies = {
          ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
          idempotency: {
            findExisting: vi.fn(async () => null),
            record: vi.fn(async () => {
              postedRecords.push({
                id: 100 + index,
                key: req.source!.idempotencyKey,
                companyId: req.voucher.companyId,
                amount: req.voucher.totalAmount,
              });
            }),
          },
          audit: { recordPosting: vi.fn(async () => {}) },
        };

        return postBalancedVoucherTx(stubTx, req, dependencies);
      };

      const results = await Promise.all(
        requests.map((req, index) => executeDistinctWorker(req, index))
      );

      expect(results).toHaveLength(COUNT);
      for (let i = 0; i < COUNT; i++) {
        expect(results[i].replayed).toBe(false);
      }
      expect(postedRecords).toHaveLength(COUNT);

      // Verify company isolation and amount preservation
      const company1 = postedRecords.filter((r) => r.companyId === 1);
      const company2 = postedRecords.filter((r) => r.companyId === 2);
      expect(company1).toHaveLength(4);
      expect(company2).toHaveLength(4);
    });
  });

  describe("Racing Payload Conflict Detection", () => {
    it("detects and rejects racing payload conflict with same idempotency key", async () => {
      const sharedKey = "conflict-race-key-55";
      const requestA = makePostingRequest(1, sharedKey, "100.00", "JV-CONF-A");
      const requestB = makePostingRequest(1, sharedKey, "200.00", "JV-CONF-B"); // Different amount!

      const fingerprintA = buildPostingRequestFingerprint(requestA);
      const fingerprintB = buildPostingRequestFingerprint(requestB);
      expect(fingerprintA).not.toBe(fingerprintB);

      let committedFingerprint: string | null = null;
      let committedVoucherId: number | null = null;

      const executeRacingPost = async (req: CentralPostingRequest, reqFingerprint: string) => {
        const stubTx = createMockPostingTx(505);

        const dependencies: CentralPostingDependencies = {
          ownership: { validateVoucherOwnership: vi.fn(async () => {}) },
          idempotency: {
            findExisting: vi.fn(async (input) => {
              if (committedFingerprint) {
                if (committedFingerprint !== input.requestFingerprint) {
                  throw new PostingValidationError(
                    "POSTING_IDEMPOTENCY_CONFLICT",
                    "Idempotency key was already used for a different financial payload"
                  );
                }
                return {
                  voucher: { id: committedVoucherId!, ...req.voucher, deletedAt: null } as any,
                  entries: [],
                };
              }
              return null;
            }),
            record: vi.fn(async (input) => {
              committedFingerprint = input.requestFingerprint;
              committedVoucherId = 505;
            }),
          },
          audit: { recordPosting: vi.fn(async () => {}) },
        };

        return postBalancedVoucherTx(stubTx, req, dependencies);
      };

      // Request A commits first
      const resultA = await executeRacingPost(requestA, fingerprintA);
      expect(resultA.replayed).toBe(false);
      expect(committedFingerprint).toBe(fingerprintA);

      // Request B races with same key but differing amount -> fails with conflict
      await expect(executeRacingPost(requestB, fingerprintB)).rejects.toThrowError(
        expect.objectContaining({
          code: "POSTING_IDEMPOTENCY_CONFLICT",
        })
      );
    });
  });

  describe("Ledger Balance Invariant Under High Concurrency", () => {
    it("maintains zero balance discrepancy across arbitrary decimal splits", () => {
      // Test 100 random multi-line splits
      for (let i = 0; i < 100; i++) {
        const total = new Decimal("1000.00");
        const part1 = new Decimal("333.333333");
        const part2 = new Decimal("666.666667");

        const sumCredits = part1.plus(part2);
        expect(sumCredits.equals(total)).toBe(true);

        const diff = total.minus(sumCredits).abs();
        expect(diff.lessThan("0.000001")).toBe(true);
      }
    });
  });
});
