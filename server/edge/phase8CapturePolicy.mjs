/**
 * Phase 8 initial LAN capture is intentionally narrower than the generic
 * voucher HTTP route: USD active journals with ledger accounts only. Other
 * voucher types, currencies, attachments and stock remain blocked in Phase 9.
 * The restrictions below guarantee the protected central route handles it.
 */
const MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$/;
const HEADER = new Set([
  "voucherType",
  "voucherDate",
  "currency",
  "optional",
  "voucherNumber",
  "description",
  "exchangeRate",
  "locationId",
  "effectiveDate",
]);
const LINE = new Set(["ledgerAccountId", "debitAmount", "creditAmount", "narration"]);
const TOP_LEVEL = new Set(["clientRequestId", "voucher", "entries"]);

function cents(value) {
  const text = String(value ?? "0");
  if (!MONEY.test(text)) return null;
  const [whole, decimal = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt((decimal + "00").slice(0, 2));
}

export function supportsPhase8LanVoucherCapture(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !TOP_LEVEL.has(key)) ||
    typeof body.clientRequestId !== "string" ||
    // The immutable outbox uses UUID operation IDs. Non-UUID request
    // identities must not silently fall back to a different random ID.
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.clientRequestId) ||
    !body.voucher ||
    typeof body.voucher !== "object" ||
    Array.isArray(body.voucher) ||
    !Array.isArray(body.entries) ||
    body.entries.length < 2 ||
    body.entries.length > 100
  )
    return false;
  const voucher = body.voucher;
  if (
    Object.keys(voucher).some((key) => !HEADER.has(key)) ||
    voucher.voucherType !== "Journal" ||
    voucher.optional === true ||
    String(voucher.currency ?? "USD") !== "USD" ||
    voucher.locationId != null ||
    voucher.effectiveDate != null ||
    typeof voucher.voucherDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(voucher.voucherDate)
  )
    return false;
  // The cloud apply path requires a real calendar day, not a string that
  // merely looks like YYYY-MM-DD (e.g. February 30).
  const parsedDay = new Date(voucher.voucherDate + "T00:00:00Z");
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== voucher.voucherDate)
    return false;
  let debit = 0n;
  let credit = 0n;
  for (const entry of body.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !LINE.has(key)) ||
      !Number.isSafeInteger(Number(entry.ledgerAccountId)) ||
      Number(entry.ledgerAccountId) < 1
    )
      return false;
    const d = cents(entry.debitAmount);
    const c = cents(entry.creditAmount);
    if (d == null || c == null || (d === 0n) === (c === 0n)) return false;
    debit += d;
    credit += c;
  }
  return debit > 0n && debit === credit;
}
