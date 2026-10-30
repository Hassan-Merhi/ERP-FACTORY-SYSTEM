/**
 * Phase 8 initial LAN capture is intentionally narrower than the generic
 * voucher HTTP route: USD active journals with ledger accounts only. Other
 * voucher types/currency/attachments/stock remain blocked pending Phase 9.
 */
export function supportsPhase8LanVoucherCapture(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.clientRequestId !== "string" ||
      body.clientRequestId.length < 1 || body.clientRequestId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(body.clientRequestId) ||
      !body.voucher || typeof body.voucher !== "object" ||
      Array.isArray(body.voucher) || !Array.isArray(body.entries) ||
      body.entries.length < 2 || body.entries.length > 100) return false;
  const voucher = body.voucher;
  if (voucher.voucherType !== "Journal" ||
      voucher.optional === true || String(voucher.currency ?? "USD") !== "USD" ||
      voucher.locationId != null || voucher.effectiveDate != null ||
      voucher.deletedAt != null || voucher.sourceModule === "POS" ||
      typeof voucher.voucherDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(voucher.voucherDate)) return false;
  return body.entries.every((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) &&
    Number.isSafeInteger(Number(entry.ledgerAccountId)) &&
    Number(entry.ledgerAccountId) > 0 &&
    ["bankAccountId","fixedAssetId","supplierId","employeeId","customerId","factorySupplierId"].every(
      (field) => entry[field] == null
    )
  );
}
