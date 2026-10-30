/** Pure, testable Phase 8 voucher scope validator. No DB or credentials. */
import { Phase8ApplyRefusal } from "./phase8ApplyStore.mjs";

function isoDate(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(raw)) {
    throw new Phase8ApplyRefusal("PHASE8_VOUCHER_DATE_UNSUPPORTED");
  }
  const day = raw.slice(0, 10);
  if (Number.isNaN(Date.parse(day + "T00:00:00Z")) ||
      new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day) {
    throw new Phase8ApplyRefusal("PHASE8_VOUCHER_DATE_INVALID");
  }
  return day;
}

export function approvedPhase8JournalShape(event) {
  const voucher = event.payload?.voucher;
  const entries = event.payload?.entries;
  if (!voucher || !Array.isArray(entries) || entries.length < 2 || entries.length > 100 ||
      voucher.id !== event.localVoucherId || voucher.companyId !== event.companyId ||
      voucher.optional === true || voucher.voucherType !== "Journal" ||
      String(voucher.currency ?? "USD") !== "USD" ||
      voucher.locationId != null || voucher.effectiveDate != null ||
      voucher.deletedAt != null || voucher.sourceModule === "POS") {
    throw new Phase8ApplyRefusal("PHASE8_UNSUPPORTED_VOUCHER_SHAPE");
  }
  const date = isoDate(voucher.voucherDate);
  const targetIds = new Set();
  const sanitizedEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Number.isSafeInteger(Number(entry.ledgerAccountId)) ||
        Number(entry.ledgerAccountId) < 1 ||
        ["bankAccountId","fixedAssetId","supplierId","employeeId","customerId","factorySupplierId"].some(
          (field) => entry[field] != null
        )) {
      throw new Phase8ApplyRefusal("PHASE8_LEDGER_ONLY_TARGETS_REQUIRED");
    }
    const accountId = Number(entry.ledgerAccountId);
    targetIds.add(accountId);
    return {
      ledgerAccountId: accountId,
      debitAmount: String(entry.debitAmount ?? "0"),
      creditAmount: String(entry.creditAmount ?? "0"),
      narration: typeof entry.narration === "string" ? entry.narration : null,
    };
  });
  return { voucher, date, entries: sanitizedEntries, ledgerAccountIds: [...targetIds] };
}

