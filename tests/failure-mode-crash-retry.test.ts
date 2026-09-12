import { describe, expect, it, vi } from "vitest";
import {
  reserveFinancialOperationTx,
  completeFinancialOperationTx,
  financialOperationFingerprint,
  DurableFinancialOperationError,
  type DurableFinancialOperationInput,
} from "../server/services/accounting/durableFinancialOperation";
import { retryAsync, isEmailConfigError, isWaConfigError, type RetryResult } from "../server/helpers/retryAsync";
import type { DbTransaction } from "../server/db";

describe("Failure-Mode Suite: Crash / Retry Resilience", () => {
  describe("Crash Before Commit vs Crash After Commit", () => {
    const payload = { recipientId: 44, amount: "500.00", currency: "USD" };
    const fingerprint = financialOperationFingerprint(payload);

    const input: DurableFinancialOperationInput = {
      companyId: 10,
      operationName: "contractor-settlement",
      idempotencyKey: "settlement-crash-probe-01",
      requestFingerprint: fingerprint,
    };

    it("handles crash before commit: rolled-back transaction allows client retry to become owner", async () => {
      let committedState: { state: string; resultBody: unknown; resultReference: string } | null = null;

      // Mock transaction executor simulating DB state across crashes
      const runTransactionAttempt = async (crashBeforeCommit: boolean) => {
        let uncommittedState: { state: string; resultBody: unknown; resultReference: string } | null = null;

        const fakeTx = {
          execute: vi.fn(async (query: any) => {
            const str = query?.queryChunks
              ? query.queryChunks.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join(" ")
              : String(query);

            if (str.includes("pg_advisory_xact_lock")) return { rows: [] };

            if (str.includes("INSERT INTO financial_operation_requests")) {
              if (committedState) {
                return { rows: [], rowCount: 0 };
              }
              uncommittedState = { state: "processing", resultBody: null, resultReference: "" };
              return { rows: [{ id: 1 }], rowCount: 1 };
            }

            if (str.includes("UPDATE financial_operation_requests")) {
              if (uncommittedState) {
                uncommittedState.state = "completed";
                uncommittedState.resultBody = { settlementId: 789, status: "SUCCESS" };
                uncommittedState.resultReference = "SETTLE-789";
                return { rowCount: 1 };
              }
              return { rowCount: 0 };
            }

            return { rows: [] };
          }),
        } as unknown as DbTransaction;

        const claim = await reserveFinancialOperationTx(fakeTx, input);

        if (claim.kind === "owner") {
          // Perform business logic
          const businessResult = { settlementId: 789, status: "SUCCESS" };

          if (crashBeforeCommit) {
            // Process crashed / power loss / DB severed before COMMIT:
            // uncommittedState is discarded (PostgreSQL rollback)
            throw new Error("Server process crashed or network disconnected before COMMIT");
          }

          await completeFinancialOperationTx(fakeTx, claim.input, businessResult, "SETTLE-789", 200);
          // Transaction commits to DB:
          committedState = uncommittedState;
          return { status: "COMMITTED", claim, result: businessResult };
        }

        return { status: "REPLAY", claim };
      };

      // 1. Initial request starts, but server crashes before commit
      await expect(runTransactionAttempt(true)).rejects.toThrow("crashed or network disconnected");
      expect(committedState).toBeNull();

      // 2. Client retries with same idempotency key
      const retryResult = await runTransactionAttempt(false);
      expect(retryResult.status).toBe("COMMITTED");
      expect(retryResult.claim.kind).toBe("owner");
      expect(committedState).toEqual({
        state: "completed",
        resultBody: { settlementId: 789, status: "SUCCESS" },
        resultReference: "SETTLE-789",
      });
    });

    it("handles crash after commit: client retry safely returns replay without duplicate execution", async () => {
      // Pre-committed state in database
      const committedRow = {
        operationName: input.operationName,
        requestFingerprint: input.requestFingerprint,
        state: "completed",
        resultReference: "SETTLE-789",
        resultStatus: 200,
        resultBody: { settlementId: 789, status: "SUCCESS" },
      };

      const businessSideEffect = vi.fn();

      const fakeTx = {
        execute: vi.fn(async (query: any) => {
          const str = query?.queryChunks
            ? query.queryChunks.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join(" ")
            : String(query);

          if (str.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (str.includes("INSERT INTO financial_operation_requests")) {
            // Conflict on existing committed row
            return { rows: [], rowCount: 0 };
          }
          if (str.includes("SELECT") && str.includes("financial_operation_requests")) {
            return { rows: [committedRow], rowCount: 1 };
          }
          return { rows: [] };
        }),
      } as unknown as DbTransaction;

      // Client retrying after timeout
      const claim = await reserveFinancialOperationTx(fakeTx, input);

      expect(claim.kind).toBe("replay");
      if (claim.kind === "replay") {
        expect(claim.stored.resultBody).toEqual({ settlementId: 789, status: "SUCCESS" });
        expect(claim.stored.resultReference).toBe("SETTLE-789");
      } else {
        businessSideEffect();
      }

      // Proves side effect was NOT re-executed
      expect(businessSideEffect).not.toHaveBeenCalled();
    });

    it("fails closed on uncertain / hung processing state", async () => {
      // Row stuck in 'processing' state (e.g. hung worker or unfinished transaction)
      const hungRow = {
        operationName: input.operationName,
        requestFingerprint: input.requestFingerprint,
        state: "processing",
        resultReference: null,
        resultStatus: null,
        resultBody: null,
      };

      const fakeTx = {
        execute: vi.fn(async (query: any) => {
          const str = query?.queryChunks
            ? query.queryChunks.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join(" ")
            : String(query);

          if (str.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (str.includes("INSERT INTO financial_operation_requests")) {
            return { rows: [], rowCount: 0 };
          }
          if (str.includes("SELECT") && str.includes("financial_operation_requests")) {
            return { rows: [hungRow], rowCount: 1 };
          }
          return { rows: [] };
        }),
      } as unknown as DbTransaction;

      const claim = await reserveFinancialOperationTx(fakeTx, input);
      expect(claim.kind).toBe("uncertain");
    });
  });

  describe("Retry Helper with Backoff & Transient Error Handling", () => {
    it("successfully retries transient errors and succeeds on attempt N", async () => {
      let callCount = 0;
      const attemptsRecorded: number[] = [];

      const result: RetryResult<{ data: string }> = await retryAsync({
        label: "test-transient-retry",
        attempts: 3,
        delayMs: 10,
        onAttempt: (attempt) => attemptsRecorded.push(attempt),
        fn: async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error("Transient connection error");
          }
          return { data: "success-data" };
        },
        isSuccess: (res) => res.data === "success-data",
      });

      expect(result.attempts).toBe(3);
      expect(result.result).toEqual({ data: "success-data" });
      expect(attemptsRecorded).toEqual([1, 2, 3]);
    });

    it("aborts immediately when encountering non-retryable configuration errors", async () => {
      let callCount = 0;

      const result = await retryAsync<{ status: string; error?: string }>({
        label: "test-non-retryable",
        attempts: 4,
        delayMs: 10,
        fn: async () => {
          callCount++;
          return { status: "failed", error: "Gmail authentication failed: bad credentials" };
        },
        isSuccess: (res) => res.status === "ok",
        shouldRetry: (res) => !isEmailConfigError(res.error ?? ""),
      });

      // Should stop at attempt 1 because error is permanent configuration error
      expect(callCount).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.result.status).toBe("failed");
    });

    it("identifies WhatsApp permanent configuration errors", () => {
      expect(isWaConfigError("WhatsApp is disabled in settings")).toBe(true);
      expect(isWaConfigError("WhatsApp client not configured")).toBe(true);
      expect(isWaConfigError("File too large for whatsapp attachment")).toBe(true);
      expect(isWaConfigError("Socket timeout on network transport")).toBe(false);
    });

    it("identifies Email permanent configuration errors", () => {
      expect(isEmailConfigError("Email not configured")).toBe(true);
      expect(isEmailConfigError("No email recipients provided")).toBe(true);
      expect(isEmailConfigError("Gmail authentication failed")).toBe(true);
      expect(isEmailConfigError("Attachment exceeds Gmail size limit")).toBe(true);
      expect(isEmailConfigError("SMTP connection reset by peer")).toBe(false);
    });

    it("propagates the final error after exhausting all retry attempts", async () => {
      let callCount = 0;

      await expect(
        retryAsync({
          label: "exhaustion-test",
          attempts: 3,
          delayMs: 5,
          fn: async () => {
            callCount++;
            throw new Error("Persistent database failure");
          },
          isSuccess: () => true,
        })
      ).rejects.toThrow("Persistent database failure");

      expect(callCount).toBe(3);
    });
  });
});
