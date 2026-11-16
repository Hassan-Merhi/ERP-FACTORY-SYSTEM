/**
 * Phase 4 — route validation / 400-path coverage.
 *
 * These requests deliberately stop at the HTTP validation boundary. A malformed
 * client request must never fall through to a PostgreSQL cast/constraint error
 * and become a 500.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p4valid";
let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status).toBe(200);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 4 validation branches", () => {
  it("returns 400 for an empty voucher payload instead of a database error", async () => {
    const response = await agent.post("/api/vouchers").send({});
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/invalid request data/i);
  });

  it("returns 400 for malformed numeric route IDs", async () => {
    const [ledger, stock] = await Promise.all([
      agent.get("/api/accounts/ledger/not-a-number/balance"),
      agent.get("/api/stock-items/not-a-number"),
    ]);

    expect(ledger.status).toBe(400);
    expect(stock.status).toBe(400);
  });

  it("returns 400 for a malformed account-statement date", async () => {
    const response = await agent.get(
      `/api/accounts/ledger/${ctx.cashAccountId}/pre-period-balance?endDate=2026-02-31`
    );

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/date|yyyy-mm-dd/i);
  });

  it("returns 400 for malformed dates on canonical accounting creates", async () => {
    const badDate = "2026-02-31";
    const [journal, payment, generic, note] = await Promise.all([
      agent.post("/api/vouchers/journal").send({
        voucherDate: badDate,
        clientRequestId: `${TEST_PREFIX}-bad-date-journal`,
        entries: [
          { type: "DR", accountType: "ledger", accountId: ctx.cashAccountId, amount: "10" },
          { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount: "10" },
        ],
      }),
      agent.post("/api/vouchers/payment-receipt").send({
        voucherType: "Payment",
        voucherDate: badDate,
        paymentAccountType: "ledger",
        paymentAccountId: ctx.cashAccountId,
        clientRequestId: `${TEST_PREFIX}-bad-date-payment`,
        entries: [{ accountType: "ledger", accountId: ctx.salesAccountId, amount: "10" }],
      }),
      agent.post("/api/vouchers/with-entries").send({
        clientRequestId: `${TEST_PREFIX}-bad-date-generic`,
        voucher: {
          voucherNumber: `P4-BAD-DATE-${Date.now()}`,
          voucherType: "Contra",
          voucherDate: badDate,
          currency: "USD",
        },
        entries: [
          { ledgerAccountId: ctx.cashAccountId, debitAmount: "10", creditAmount: "0" },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "10" },
        ],
      }),
      agent.post("/api/credit-notes").send({
        noteType: "Credit Note",
        voucherDate: badDate,
        cashAccountType: "ledger",
        cashAccountId: ctx.cashAccountId,
        items: [
          {
            stockItemId: ctx.stockItemIds[0],
            locationId: ctx.locationId,
            quantity: "1",
            refundRate: "10",
            inventoryCost: "10",
          },
        ],
      }),
    ]);

    for (const response of [journal, payment, generic, note]) {
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/date|yyyy-mm-dd/i);
    }
  });

  it("returns 400 for invalid accounting amounts before persistence", async () => {
    const response = await agent.post("/api/vouchers/payment-receipt").send({
      voucherType: "Payment",
      voucherDate: "2026-09-14",
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      clientRequestId: `${TEST_PREFIX}-bad-amount`,
      entries: [
        {
          accountType: "ledger",
          accountId: ctx.salesAccountId,
          amount: "not-a-number",
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/amount/i);
  });

  it("returns 400 for non-positive stock quantities", async () => {
    const response = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: "2026-09-14",
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "0",
          refundRate: "10.00",
          inventoryCost: "10.00",
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/quantity/i);
  });

  it("returns 400 for bad enum values", async () => {
    const payment = await agent.post("/api/vouchers/payment-receipt").send({
      voucherType: "WireTransfer",
      voucherDate: "2026-09-14",
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      clientRequestId: `${TEST_PREFIX}-bad-enum-payment`,
      entries: [{ accountType: "ledger", accountId: ctx.salesAccountId, amount: "10" }],
    });
    const note = await agent.post("/api/credit-notes").send({
      noteType: "Refund Note",
      voucherDate: "2026-09-14",
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      items: [{ stockItemId: ctx.stockItemIds[0], locationId: ctx.locationId, quantity: "1" }],
    });

    expect(payment.status).toBe(400);
    expect(note.status).toBe(400);
  });

  it("returns 400 for empty canonical create payloads", async () => {
    const [journal, payment, note, generic] = await Promise.all([
      agent.post("/api/vouchers/journal").send({}),
      agent.post("/api/vouchers/payment-receipt").send({}),
      agent.post("/api/credit-notes").send({}),
      agent.post("/api/vouchers/with-entries").send({}),
    ]);

    expect(journal.status).toBe(400);
    expect(payment.status).toBe(400);
    expect(note.status).toBe(400);
    expect(generic.status).toBe(400);
  });
});
