import test from "node:test";
import assert from "node:assert/strict";
import { approvedPhase8JournalShape } from "../server/edge/phase8VoucherPolicy.mjs";

const voucher = {
  id: 88,
  companyId: 6,
  voucherType: "Journal",
  voucherDate: "2026-10-30",
  currency: "USD",
  optional: false,
  totalAmount: "10.00",
};
const entries = [
  { ledgerAccountId: 11, debitAmount: "10.00", creditAmount: "0" },
  { ledgerAccountId: 12, debitAmount: "0", creditAmount: "10.00" },
];
const event = {
  siteId: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  sequence: "1",
  operationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  companyId: 6,
  actorUserId: "actor-1",
  localVoucherId: 88,
  kind: "voucher.with-entries.v1",
  payload: { voucher, entries },
};

test("Phase 8 accepts only USD ledger-only journal with a fixed business date", () => {
  const shape = approvedPhase8JournalShape(event);
  assert.equal(shape.date, "2026-10-30");
  assert.deepEqual(shape.ledgerAccountIds, [11, 12]);
  assert.equal(shape.entries.length, 2);
});

test("Phase 8 refuses voucher IDs, tenant, stock, party, location and currency drift", () => {
  const changes = [
    { id: 89 },
    { companyId: 7 },
    { voucherType: "Payment" },
    { currency: "ZMW" },
    { optional: true },
    { locationId: 3 },
    { sourceModule: "POS" },
    { deletedAt: "2026-10-30" },
    { effectiveDate: "2026-10-29" },
  ];
  for (const change of changes) {
    assert.throws(
      () =>
        approvedPhase8JournalShape({
          ...event,
          payload: { ...event.payload, voucher: { ...voucher, ...change } },
        }),
      /PHASE8_UNSUPPORTED_VOUCHER_SHAPE/
    );
  }
  assert.throws(
    () =>
      approvedPhase8JournalShape({
        ...event,
        payload: { ...event.payload, entries: [{ ...entries[0], employeeId: 1 }, entries[1]] },
      }),
    /PHASE8_LEDGER_ONLY_TARGETS_REQUIRED/
  );
});

test("Phase 8 does not silently shift invalid historical business dates", () => {
  for (const date of ["2026-02-30", "2026-11-31", "tomorrow", "2026-10-30T12:00:00Z"]) {
    assert.throws(
      () =>
        approvedPhase8JournalShape({
          ...event,
          payload: { ...event.payload, voucher: { ...voucher, voucherDate: date } },
        }),
      /PHASE8_VOUCHER_DATE/
    );
  }
});
