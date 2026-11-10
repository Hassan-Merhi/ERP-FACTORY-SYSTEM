/**
 * Phase 3: preview-only trip-charge arithmetic and input constraints.
 * No invoice, payable, stock, voucher, or customer balance postings.
 */
import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney } from "../../../lib/money";

export type TripChargeKind = "BILLABLE" | "INTERNAL" | "DISCOUNT";
export type ErpChargeType = "freight" | "surcharge" | "fumigation" | "documentCharges" | null;

export interface TripChargeRow {
  id: number;
  name: string;
  kind: TripChargeKind;
  amount: string;
  currency: string;
  ledgerAccountId: number;
  offsetLedgerAccountId: number | null;
  erpChargeType: ErpChargeType;
  notes: string | null;
  revision: number;
  lockedAt?: string | null;
  updatedAt?: string | null;
}

export class TripChargeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TripChargeValidationError";
  }
}

function invalid(message: string): never {
  throw new TripChargeValidationError(message);
}

export function validAmount(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") invalid("Enter a valid charge amount");
  const raw = String(value).trim();
  if (!/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?$/.test(raw)) {
    invalid("Charge must be a non-negative amount with at most two decimal places");
  }
  const amount = new MoneyDecimal(raw);
  if (!amount.isFinite() || !amount.gt(0)) invalid("Charge amount must be greater than zero");
  return amount.toFixed(2);
}

export function validChargeInput(value: unknown): {
  name: string;
  kind: TripChargeKind;
  amount: string;
  ledgerAccountId: number;
  offsetLedgerAccountId: number | null;
  erpChargeType: ErpChargeType;
  notes: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid charge");
  const data = value as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || name.length > 160) invalid("Charge name is required (maximum 160 characters)");
  if (!["BILLABLE", "INTERNAL", "DISCOUNT"].includes(String(data.kind ?? ""))) {
    invalid("Select billable, internal expense or discount");
  }
  const kind = data.kind as TripChargeKind;
  const amount = validAmount(data.amount);
  const ledgerAccountId = Number(data.ledgerAccountId);
  if (!Number.isSafeInteger(ledgerAccountId) || ledgerAccountId <= 0) invalid("Choose a valid ledger account");
  const offsetLedgerAccountId = data.offsetLedgerAccountId === null || data.offsetLedgerAccountId === undefined ||
    data.offsetLedgerAccountId === "" ? null : Number(data.offsetLedgerAccountId);
  if (offsetLedgerAccountId !== null &&
      (!Number.isSafeInteger(offsetLedgerAccountId) || offsetLedgerAccountId <= 0)) {
    invalid("Choose a valid offset account");
  }
  if (kind === "INTERNAL" && !offsetLedgerAccountId) invalid("Internal expenses require a payable or offset account");
  if (kind !== "INTERNAL" && offsetLedgerAccountId !== null) {
    invalid("Only internal expenses use a separate offset account");
  }
  if (offsetLedgerAccountId === ledgerAccountId) invalid("A charge cannot debit and credit the same account");

  const erpChargeType = data.erpChargeType === null || data.erpChargeType === undefined ||
    data.erpChargeType === "" ? null : String(data.erpChargeType);
  if (!([null, "freight", "surcharge", "fumigation", "documentCharges"] as unknown[]).includes(erpChargeType)) {
    invalid("ERP PO export only accepts supported charge types");
  }
  if (kind === "INTERNAL" && erpChargeType !== null) invalid("Internal expenses cannot become ERP supplier charges");
  const notes = data.notes === null || data.notes === undefined || data.notes === ""
    ? null : String(data.notes).trim();
  if (notes && notes.length > 1000) invalid("Notes must be 1,000 characters or fewer");
  return {
    name, kind, amount, ledgerAccountId, offsetLedgerAccountId,
    erpChargeType: erpChargeType as ErpChargeType, notes,
  };
}

export function accountAcceptsCharge(kind: TripChargeKind, accountType: string): boolean {
  const type = accountType.trim().toLowerCase().replace(/[_-]/g, " ");
  if (kind === "BILLABLE") return /income|revenue|sales/.test(type);
  if (kind === "DISCOUNT") return /income|revenue|sales|expense|discount/.test(type);
  return /expense|cost|inventory|asset/.test(type);
}

export function accountAcceptsOffset(accountType: string): boolean {
  const type = accountType.trim().toLowerCase().replace(/[_-]/g, " ");
  return /liability|payable|cash|bank|asset/.test(type);
}

/**
 * Fingerprint includes saved charge values and IDs, not display-only account
 * names or timestamps. Concurrency checks compare under the locked order/trip.
 */
export function tripChargeFingerprint(charges: readonly TripChargeRow[]): string {
  const normalized = charges.map((c) => [
    c.id, c.revision, c.name, c.kind, c.amount, c.currency, c.ledgerAccountId,
    c.offsetLedgerAccountId, c.erpChargeType, c.notes, c.lockedAt ?? null,
  ]).sort((a, b) => Number(a[0]) - Number(b[0]));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function exact(value: string): Decimal {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) invalid("Invalid stored monetary value");
  return new MoneyDecimal(value);
}

export function buildTripChargePreview(goodsSubtotal: string, charges: readonly TripChargeRow[]) {
  const goods = exact(goodsSubtotal);
  const billable = sumMoney(charges.filter(c => c.kind === "BILLABLE").map(c => exact(c.amount)));
  const discount = sumMoney(charges.filter(c => c.kind === "DISCOUNT").map(c => exact(c.amount)));
  const internal = sumMoney(charges.filter(c => c.kind === "INTERNAL").map(c => exact(c.amount)));
  const total = goods.plus(billable).minus(discount);
  if (total.isNegative()) invalid("Discounts exceed the goods and billed charges");
  return {
    goodsSubtotal: goods.toFixed(2),
    billableChargesTotal: billable.toFixed(2),
    discountTotal: discount.toFixed(2),
    internalExpenseTotal: internal.toFixed(2),
    customerTotal: total.toFixed(2),
    chargeCount: charges.length,
  };
}
