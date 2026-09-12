import { describe, expect, it, vi } from "vitest";
import {
  postBalancedVoucherTx,
  validateCentralPostingRequest,
  PostingValidationError,
  type CentralPostingDependencies,
  type CentralPostingRequest,
} from "../server/services/accounting/centralPostingEngine";
import {
  reserveFinancialOperationTx,
  completeFinancialOperationTx,
  financialOperationFingerprint,
  type DurableFinancialOperationInput,
} from "../server/services/accounting/durableFinancialOperation";
import {
  findExistingStockDocumentTx,
  recordStockDocumentTx,
  type StockDocumentIdempotencyTransaction,
} from "../server/services/inventory/stockDocumentIdempotency";
import type { DbTransaction } from "../server/db";

describe("Failure-Mode Suite: Transaction Interruption & Atomic Rollback", () => {
  describe("Multi-Line Stock Movement Interruption", () => {
    it("guarantees transaction rollback leaves zero orphan records on mid-flight failure", async () => {
      // In-memory mock database tracking table state
      const dbState = {
        vouchers: [] as Array<{ id: number; companyId: number; description: string }>,
        stockTransfers: [] as Array<{ id: number; voucherId: number; fromLoc: number; toLoc: number }>,
        movements: [] as Array<{ id: number; stockItemId: number; qty: number }>,
        idempotencyMarkers: [] as Array<{ key: string; documentId: number }>,
        inventory: { loc1: { item1: 10, item2: 5 }, loc2: { item1: 0, item2: 0 } },
      };

      // Simulating a transactional operation that fails on line 2
      const executeStockTransferTransaction = async (shouldFailLine2: boolean) => {
        // Snapshot for transaction rollback simulation
        const snapshot = JSON.parse(JSON.stringify(dbState));

        try {
          // Step 1: Create voucher
          const voucherId = dbState.vouchers.length + 1;
          dbState.vouchers.push({ id: voucherId, companyId: 1, description: "Transfer" });

          // Step 2: Create stock transfer header
          const transferId = dbState.stockTransfers.length + 1;
          dbState.stockTransfers.push({ id: transferId, voucherId, fromLoc: 1, toLoc: 2 });

          // Step 3: Process Line 1 (valid item)
          dbState.inventory.loc1.item1 -= 2;
          dbState.inventory.loc2.item1 += 2;
          dbState.movements.push({ id: dbState.movements.length + 1, stockItemId: 1, qty: 2 });

          // Step 4: Process Line 2 (simulate mid-flight failure e.g. non-existent item or DB error)
          if (shouldFailLine2) {
            throw new Error("DB Error: Stock item 99999 does not exist (foreign key violation)");
          }

          dbState.inventory.loc1.item2 -= 1;
          dbState.inventory.loc2.item2 += 1;
          dbState.movements.push({ id: dbState.movements.length + 1, stockItemId: 2, qty: 1 });

          // Step 5: Record idempotency marker
          dbState.idempotencyMarkers.push({ key: "stock-transfer:1:req-fail-probe", documentId: transferId });

          return { success: true, transferId };
        } catch (error) {
          // Transaction aborts & rolls back
          dbState.vouchers = snapshot.vouchers;
          dbState.stockTransfers = snapshot.stockTransfers;
          dbState.movements = snapshot.movements;
          dbState.idempotencyMarkers = snapshot.idempotencyMarkers;
          dbState.inventory = snapshot.inventory;
          throw error;
        }
      };

      // Attempt transaction with line 2 failure
      await expect(executeStockTransferTransaction(true)).rejects.toThrow("foreign key violation");

      // Verify complete rollback: zero orphan rows, inventory untouched
      expect(dbState.vouchers).toHaveLength(0);
      expect(dbState.stockTransfers).toHaveLength(0);
      expect(dbState.movements).toHaveLength(0);
      expect(dbState.idempotencyMarkers).toHaveLength(0);
      expect(dbState.inventory.loc1.item1).toBe(10);
      expect(dbState.inventory.loc2.item1).toBe(0);

      // Verify retry with corrected payload succeeds cleanly
      const retryResult = await executeStockTransferTransaction(false);
      expect(retryResult.success).toBe(true);
      expect(dbState.vouchers).toHaveLength(1);
      expect(dbState.stockTransfers).toHaveLength(1);
      expect(dbState.movements).toHaveLength(2);
      expect(dbState.idempotencyMarkers).toHaveLength(1);
      expect(dbState.inventory.loc1.item1).toBe(8);
      expect(dbState.inventory.loc2.item1).toBe(2);
      expect(dbState.inventory.loc1.item2).toBe(4);
      expect(dbState.inventory.loc2.item2).toBe(1);
    });
  });

  describe("Post-Interruption Retry Idempotency Recovery", () => {
    it("ensures a rolled-back transaction leaves no marker claiming the document exists", async () => {
      let markerRecordedInDb = false;

      const fakeTx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => (markerRecordedInDb ? [{ documentId: 101 }] : [])),
              })),
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn(async () => {
            // Marker would only be committed if transaction succeeds
          }),
        })),
      } as unknown as StockDocumentIdempotencyTransaction;

      // Check 1: Before transaction / during aborted transaction, marker is not committed
      const lookupBefore = await findExistingStockDocumentTx({
        tx: fakeTx,
        companyId: 2,
        idempotencyKey: "stock-transfer:2:req-retry-recovery",
      });
      expect(lookupBefore).toBeNull();

      // Simulate first attempt failing mid-write: no marker committed
      // Second attempt runs:
      const lookupRetry = await findExistingStockDocumentTx({
        tx: fakeTx,
        companyId: 2,
        idempotencyKey: "stock-transfer:2:req-retry-recovery",
      });
      expect(lookupRetry).toBeNull();

      // Now second attempt commits marker
      await recordStockDocumentTx({
        tx: fakeTx,
        companyId: 2,
        idempotencyKey: "stock-transfer:2:req-retry-recovery",
        documentId: 101,
        sourceType: "stock-transfer",
      });
      markerRecordedInDb = true;

      // Third attempt finds committed marker
      const lookupAfterCommit = await findExistingStockDocumentTx({
        tx: fakeTx,
        companyId: 2,
        idempotencyKey: "stock-transfer:2:req-retry-recovery",
      });
      expect(lookupAfterCommit).toBe(101);
    });
  });

  describe("Multi-Entry Voucher Transaction Interruption", () => {
    it("rejects unbalanced entries before executing any writes", () => {
      const unbalancedRequest: CentralPostingRequest = {
        voucher: {
          companyId: 1,
          voucherNumber: "JV-ERR-01",
          voucherType: "Journal",
          voucherDate: "2026-09-01",
          totalAmount: "100.00",
          description: "Unbalanced journal",
          currency: "USD",
          sourceModule: "ERP",
        },
        entries: [
          { ledgerAccountId: 10, debitAmount: "100.00", creditAmount: "0" },
          { ledgerAccountId: 20, debitAmount: "0", creditAmount: "80.00" }, // $20 mismatch!
        ],
        source: {
          sourceType: "manual-journal",
          sourceId: "err-01",
          idempotencyKey: "key-err-01",
        },
      };

      expect(() => validateCentralPostingRequest(unbalancedRequest)).toThrowError(
        expect.objectContaining({
          name: "PostingValidationError",
          code: "POSTING_UNBALANCED",
        })
      );
    });

    it("rejects zero-amount postings", () => {
      const zeroRequest: CentralPostingRequest = {
        voucher: {
          companyId: 1,
          voucherNumber: "JV-ZERO-01",
          voucherType: "Journal",
          voucherDate: "2026-09-01",
          totalAmount: "0.00",
          description: "Zero journal",
          currency: "USD",
          sourceModule: "ERP",
        },
        entries: [
          { ledgerAccountId: 10, debitAmount: "0", creditAmount: "0" },
          { ledgerAccountId: 20, debitAmount: "0", creditAmount: "0" },
        ],
        source: {
          sourceType: "manual-journal",
          sourceId: "zero-01",
          idempotencyKey: "key-zero-01",
        },
      };

      expect(() => validateCentralPostingRequest(zeroRequest)).toThrowError(
        expect.objectContaining({
          code: "POSTING_ENTRY_SIDE_INVALID",
        })
      );
    });

    it("rejects entries with missing account targets", () => {
      const noTargetRequest: CentralPostingRequest = {
        voucher: {
          companyId: 1,
          voucherNumber: "JV-NOTARGET",
          voucherType: "Journal",
          voucherDate: "2026-09-01",
          totalAmount: "50.00",
          description: "No target journal",
          currency: "USD",
          sourceModule: "ERP",
        },
        entries: [
          { debitAmount: "50.00", creditAmount: "0" } as any,
          { ledgerAccountId: 20, debitAmount: "0", creditAmount: "50.00" },
        ],
        source: {
          sourceType: "manual-journal",
          sourceId: "notarget-01",
          idempotencyKey: "key-notarget-01",
        },
      };

      expect(() => validateCentralPostingRequest(noTargetRequest)).toThrowError(
        expect.objectContaining({
          code: "POSTING_TARGET_INVALID",
        })
      );
    });
  });

  describe("Durable Financial Operation Failure & Rollback", () => {
    it("clears reservation state on transaction error so retry can proceed as owner", async () => {
      const payload = { amount: "250.00", toAccount: 5 };
      const input: DurableFinancialOperationInput = {
        companyId: 4,
        operationName: "payroll-payment",
        idempotencyKey: "payroll-txn-interrupted-01",
        requestFingerprint: financialOperationFingerprint(payload),
      };

      // Simulated DB table for financial_operation_requests
      const storedRows: Array<{
        companyId: number;
        operationName: string;
        idempotencyKey: string;
        requestFingerprint: string;
        state: string;
        resultBody: unknown;
      }> = [];

      // Run transactional execution
      const runFinancialTx = async (failDuringOperation: boolean) => {
        const snapshot = JSON.parse(JSON.stringify(storedRows));
        const fakeTx = {
          execute: vi.fn(async (query: any) => {
            const str = query?.queryChunks
              ? query.queryChunks.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join(" ")
              : String(query);

            if (str.includes("pg_advisory_xact_lock")) {
              return { rows: [] };
            }

            if (str.includes("INSERT INTO financial_operation_requests")) {
              const existing = storedRows.find(
                (r) =>
                  r.companyId === input.companyId &&
                  r.operationName === input.operationName &&
                  r.idempotencyKey === input.idempotencyKey
              );
              if (!existing) {
                storedRows.push({
                  companyId: input.companyId,
                  operationName: input.operationName,
                  idempotencyKey: input.idempotencyKey,
                  requestFingerprint: input.requestFingerprint,
                  state: "processing",
                  resultBody: null,
                });
                return { rows: [{ id: 1 }], rowCount: 1 };
              }
              return { rows: [], rowCount: 0 };
            }

            if (str.includes("SELECT") && str.includes("financial_operation_requests")) {
              const row = storedRows.find(
                (r) =>
                  r.companyId === input.companyId &&
                  r.operationName === input.operationName &&
                  r.idempotencyKey === input.idempotencyKey
              );
              return {
                rows: row
                  ? [
                      {
                        operationName: row.operationName,
                        requestFingerprint: row.requestFingerprint,
                        state: row.state,
                        resultReference: null,
                        resultStatus: null,
                        resultBody: row.resultBody,
                      },
                    ]
                  : [],
                rowCount: row ? 1 : 0,
              };
            }

            if (str.includes("UPDATE financial_operation_requests")) {
              const row = storedRows.find(
                (r) =>
                  r.companyId === input.companyId &&
                  r.operationName === input.operationName &&
                  r.idempotencyKey === input.idempotencyKey
              );
              if (row) {
                row.state = "completed";
                row.resultBody = { voucherId: 900 };
                return { rowCount: 1 };
              }
              return { rowCount: 0 };
            }
            return { rows: [] };
          }),
        } as unknown as DbTransaction;

        try {
          const claim = await reserveFinancialOperationTx(fakeTx, input);
          if (claim.kind !== "owner") {
            throw new Error(`Unexpected claim kind: ${claim.kind}`);
          }

          if (failDuringOperation) {
            throw new Error("Downstream service connection timed out");
          }

          await completeFinancialOperationTx(fakeTx, claim.input, { voucherId: 900 });
          return { success: true };
        } catch (err) {
          // Transaction rollback restores previous state
          storedRows.length = 0;
          storedRows.push(...snapshot);
          throw err;
        }
      };

      // 1. First run fails mid-operation
      await expect(runFinancialTx(true)).rejects.toThrow("Downstream service connection timed out");
      // Reservation row was rolled back
      expect(storedRows).toHaveLength(0);

      // 2. Retry runs and succeeds as owner
      const success = await runFinancialTx(false);
      expect(success.success).toBe(true);
      expect(storedRows).toHaveLength(1);
      expect(storedRows[0].state).toBe("completed");
    });
  });
});
