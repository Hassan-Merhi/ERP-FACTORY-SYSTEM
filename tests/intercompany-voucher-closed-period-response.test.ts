/**
 * The paired (intercompany) Payment/Receipt route answers a closed-period
 * refusal as a definite 409 with its code, like the other voucher create
 * routes. Before, it fell through to a 500 "internal" answer, which the browser
 * reads as an uncertain outcome: it kept the request identity, so the same
 * entry was refused again after the period had been reopened.
 */
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { shouldReleaseAccountingRequestIdentity } from "../client/src/lib/accountingRequestIdentity";
import { fail } from "../server/routes/vouchers/normalIntercompanyVoucherRoutes";

function recordingResponse() {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status: vi.fn((code: number) => {
      sent.status = code;
      return res;
    }),
    json: vi.fn((body: Record<string, unknown>) => {
      sent.body = body;
      return res;
    }),
  } as unknown as Response;
  return { res, sent };
}

const guardRefusal = Object.assign(new Error("Failed query: insert into vouchers ..."), {
  cause: Object.assign(
    new Error(
      "ACCOUNTING_PERIOD_CLOSED: the books are closed through 2026-10-31, so an entry dated 2026-10-15 cannot be created, changed or deleted"
    ),
    { code: "EPL01" }
  ),
});

describe("intercompany voucher failures", () => {
  it("answer a closed period with 409 and its code, so the browser lets the identity go", () => {
    const { res, sent } = recordingResponse();

    fail(res, guardRefusal);

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({
      code: "ACCOUNTING_PERIOD_CLOSED",
      message:
        "Accounting period closed: the books are closed through 2026-10-31, so an entry dated 2026-10-15 cannot be created, changed or deleted.",
    });
    expect(shouldReleaseAccountingRequestIdentity(sent.status!, sent.body!.code as string)).toBe(true);
  });

  it("still answer an unexpected error as an internal failure the browser keeps open", () => {
    const { res, sent } = recordingResponse();

    fail(res, new Error("connection reset"));

    expect(sent.status).toBe(500);
    expect(sent.body?.code).toBe("IC_VOUCHER_INTERNAL");
    expect(shouldReleaseAccountingRequestIdentity(sent.status!, sent.body!.code as string)).toBe(false);
  });
});
