import test from "node:test";
import assert from "node:assert/strict";
import { supportsPhase8LanVoucherCapture } from "../server/edge/phase8CapturePolicy.mjs";
import { validatePhase8OperatorApproval } from "../server/edge/phase8ApplyStore.mjs";
import { validateAppliedReceiptQuery, PHASE8_RECEIPT_QUERY_PROTOCOL,
  PHASE8_RECEIPT_PROTOCOL } from "../server/edge/phase8AppliedReceipts.mjs";
import { verifyAppliedReceiptResponse } from "../scripts/edge/fetch-applied-receipts.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const operationId = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const journal = {
  clientRequestId: "phase8-test-1",
  voucher: { voucherType: "Journal", voucherDate: "2026-10-30", currency: "USD", optional: false },
  entries: [
    { ledgerAccountId: 31, debitAmount: "10.00", creditAmount: "0" },
    { ledgerAccountId: 32, debitAmount: "0", creditAmount: "10.00" },
  ],
};

test("LAN captures only explicitly supported USD ledger-only journals", () => {
  assert.equal(supportsPhase8LanVoucherCapture(journal), true);
  for (const changed of [
    { voucher: { ...journal.voucher, voucherType: "Payment" } },
    { voucher: { ...journal.voucher, currency: "ZMW" } },
    { voucher: { ...journal.voucher, optional: true } },
    { voucher: { ...journal.voucher, locationId: 4 } },
    { voucher: { ...journal.voucher, effectiveDate: "2026-10-31" } },
    { entries: [...journal.entries, { employeeId: 4 }] },
    { entries: journal.entries.map((x) => ({ ...x, customerId: 5 })) },
    { clientRequestId: "" },
    { file: { name: "receipt.pdf" } },
    { attachmentId: 23 },
    { upload: "untracked" },
  ]) {
    assert.equal(supportsPhase8LanVoucherCapture({ ...journal, ...changed }), false);
  }
});

test("LAN refuses unapplyable calendar dates before writing a voucher", () => {
  for (const day of ["2026-02-30", "2026-11-31", "2026-13-01", "2026-00-01", "2026-10-30T12:00:00Z"]) {
    assert.equal(supportsPhase8LanVoucherCapture({
      ...journal, voucher: { ...journal.voucher, voucherDate: day },
    }), false);
  }
});

test("operator replay cannot activate with ACK alone, invalid epoch, or missing baseline", () => {
  const approved = { siteId, companyId: 6, cloudEpoch: "2", baselineSha256: "a".repeat(64),
    operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED" };
  assert.equal(validatePhase8OperatorApproval(approved), approved);
  for (const changed of [
    { baselineSha256: "" }, { cloudEpoch: "0" }, { cloudEpoch: "2; DELETE" },
    { siteId: "wrong" }, { companyId: 0 }, { operatorAck: "" },
  ]) assert.throws(() => validatePhase8OperatorApproval({ ...approved, ...changed }),
    /PHASE8_OPERATOR_APPROVAL_REQUIRED/);
});

test("read-only signed receipt query is strict to the site and sequence", () => {
  const body = { protocol: PHASE8_RECEIPT_QUERY_PROTOCOL, siteId, fromSequence: "1" };
  assert.equal(validateAppliedReceiptQuery(body,siteId), body);
  for (const changed of [{ siteId: "wrong" }, { fromSequence: "0" },
    { fromSequence: "1 OR TRUE" }, { fromSequence: "9223372036854775808" }]) {
    assert.throws(() => validateAppliedReceiptQuery({ ...body, ...changed },siteId),
      /PHASE8_RECEIPT_QUERY_INVALID/);
  }
});

test("cloud-applied receipt requires exact local outbox/hash/date/actor match", () => {
  const local = {
    sequence: "1", operation_id: operationId, company_id: 6, actor_user_id: "actor-1",
    local_voucher_id: 88, business_date: "2026-10-30", payload_sha256: "a".repeat(64),
  };
  const item = {
    sequence: "1", operationId, companyId: 6, actorUserId: "actor-1", localVoucherId: 88,
    cloudVoucherId: 99, businessDate: "2026-10-30", payloadSha256: "a".repeat(64),
    state: "cloud-applied",
  };
  const receipt = { protocol: PHASE8_RECEIPT_PROTOCOL, siteId, state: "cloud-applied", events: [item] };
  assert.deepEqual(verifyAppliedReceiptResponse(receipt, siteId, [local]), [item]);
  for (const changed of [
    { state: "staged-not-applied" }, { payloadSha256: "b".repeat(64) },
    { cloudVoucherId: 0 }, { actorUserId: "other" },
    { localVoucherId: 89 }, { businessDate: "2026-10-29" },
  ]) {
    assert.throws(() => verifyAppliedReceiptResponse({
      ...receipt, events: [{ ...item, ...changed }],
    }, siteId, [local]), /PHASE8_APPLIED_RECEIPT_/);
  }
  assert.throws(() => verifyAppliedReceiptResponse({
    ...receipt, events: [item,item],
  }, siteId, [local]), /PHASE8_APPLIED_RECEIPT_INVALID/);
});
