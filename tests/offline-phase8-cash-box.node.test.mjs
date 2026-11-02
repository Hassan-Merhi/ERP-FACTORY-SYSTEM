import assert from "node:assert/strict";
import { test } from "node:test";
import { phase8CashBoxRefusal } from "../server/edge/phase8CashBoxPolicy.mjs";
import { supportsPhase8LanVoucherCapture } from "../server/edge/phase8CapturePolicy.mjs";

// 1 = factory cash box, 2 = fuel expense, 3 = scrap income, 4 = bank,
// 5 = supplier payable, 6 = second cash box.
const types = new Map([
  [1, "Cash"],
  [2, "Direct Expense"],
  [3, "Income"],
  [4, "Bank"],
  [5, "Accounts Payable"],
  [6, "Cash"],
]);
const line = (ledgerAccountId, debitAmount, creditAmount) => ({ ledgerAccountId, debitAmount, creditAmount });

test("a factory cash-box payment and receipt are allowed; journals are unaffected", () => {
  assert.equal(phase8CashBoxRefusal("Payment", [line(2, "40.00", "0"), line(1, "0", "40.00")], types), null);
  assert.equal(phase8CashBoxRefusal("Receipt", [line(1, "15.00", "0"), line(3, "0", "15.00")], types), null);
  assert.equal(phase8CashBoxRefusal("Journal", [line(4, "1", "0"), line(5, "0", "1")], types), null);
});

test("bank transfers, supplier payments and cash-to-cash moves are refused", () => {
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(5, "40.00", "0"), line(1, "0", "40.00")], types),
    "PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED"
  );
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(2, "40.00", "0"), line(4, "0", "40.00")], types),
    "PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED"
  );
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(6, "40.00", "0"), line(1, "0", "40.00")], types),
    "PHASE8_CASH_BOX_DIRECTION_INVALID"
  );
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(2, "40.00", "0"), line(1, "0", "20.00"), line(6, "0", "20.00")], types),
    "PHASE8_CASH_BOX_SINGLE_CASH_ACCOUNT_REQUIRED"
  );
});

test("direction must match the voucher type and unknown accounts are refused", () => {
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(1, "40.00", "0"), line(2, "0", "40.00")], types),
    "PHASE8_CASH_BOX_DIRECTION_INVALID"
  );
  assert.equal(
    phase8CashBoxRefusal("Receipt", [line(1, "15.00", "0"), line(2, "0", "15.00")], types),
    "PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED"
  );
  assert.equal(
    phase8CashBoxRefusal("Payment", [line(2, "40.00", "0"), line(99, "0", "40.00")], types),
    "PHASE8_LEDGER_TARGET_NOT_APPROVED"
  );
  assert.equal(phase8CashBoxRefusal("Sales", [], types), "PHASE8_UNSUPPORTED_VOUCHER_SHAPE");
});

test("the LAN capture shape admits USD cash-box payment/receipt vouchers only", () => {
  const body = (voucherType, currency = "USD") => ({
    clientRequestId: "0b6f6a4e-2c1d-4e8f-9a7b-1c2d3e4f5a6b",
    voucher: { voucherType, voucherDate: "2026-11-02", currency, optional: false },
    entries: [line(2, "40.00", "0"), line(1, "0", "40.00")],
  });
  assert.equal(supportsPhase8LanVoucherCapture(body("Payment")), true);
  assert.equal(supportsPhase8LanVoucherCapture(body("Receipt")), true);
  assert.equal(supportsPhase8LanVoucherCapture(body("Payment", "ZMW")), false);
  assert.equal(supportsPhase8LanVoucherCapture(body("Sales")), false);
});
