/**
 * Retail cash movements and shift close in the ledger (accounting audit wave
 * 17 D, owner decision 2 of 2026-10-09).
 *
 * Before: a cash in/out movement (POST /api/pos/retail/shifts/:id/cash-movements)
 * changed only the shift's expected cash, and a shift close only stored the
 * variance; neither reached the ledger.
 *
 * Now, in the movement's transaction:
 *   - cash in:  Dr the shift's cash account / Cr the reason's account;
 *   - cash out: Dr the reason's account / Cr the shift's cash account;
 * voucher RETAIL-CASH-{movement}, posting identity
 * `retail-cash-movement:{movement}`, dated on the company's business date.
 * The shift's cash account is the one the shift was opened with, else the
 * Retail settings' cash account for the shift's register (location) — the
 * account its cash sales post to. The counter-account comes from the reason
 * code: the company's mapping (retail_cash_reason_accounts) or, for a built-in
 * reason with no row, its default (a system registry account, or the Retail
 * bank account / bank clearing ledger). A reason with no account — "other",
 * or one whose mapping was cleared — refuses the movement (409
 * RETAIL_CASH_REASON_UNMAPPED) until it is mapped.
 *
 * At a Retail shift close the difference between counted and expected cash is
 * journalled (RETAIL-OVERSHORT-{shift}, identity `retail-shift-over-short:{shift}`):
 * short: Dr RETAIL-CASH-OVER-SHORT / Cr cash; over: Dr cash / Cr
 * RETAIL-CASH-OVER-SHORT (one expense account, a credit balance is a gain).
 *
 * There is no movement delete or void route. Movements recorded before this
 * wave have no voucher: listed by the integrity diagnostic, not back-filled.
 */
import type Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";

import { bankAccounts, ledgerAccounts, retailCashMovements, retailCashReasonAccounts } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { buildAuditChanges, writeAuditEvent, type AuditActor } from "../audit";
import { ensureRetailAccountingSettingsTx } from "./retailFinancialService";
import { cents, postRetailJournalTx, retailSystemAccountIdTx, type RetailJournalActor } from "./retailLedgerPosting";

export type RetailCashDirection = "cash_in" | "cash_out";

/** Built-in reasons: direction allowed, and the default counter-account. */
export const RETAIL_CASH_REASONS = {
  bank_withdrawal: { direction: "cash_in", label: "Cash in from the bank", defaultTarget: "bank" },
  owner_funding: { direction: "cash_in", label: "Cash in from the owner", defaultTarget: "RETAIL-OWNER-FUNDS" },
  expense: { direction: "cash_out", label: "Expense paid from the drawer", defaultTarget: "RETAIL-CASH-EXPENSE" },
  cash_drop: { direction: "cash_out", label: "Cash drop to the safe or bank", defaultTarget: "bank" },
  owner_drawing: { direction: "cash_out", label: "Cash taken by the owner", defaultTarget: "RETAIL-OWNER-FUNDS" },
  other: { direction: "either", label: "Other (map an account first)", defaultTarget: null },
} as const satisfies Record<
  string,
  { direction: RetailCashDirection | "either"; label: string; defaultTarget: string | null }
>;

export type RetailBuiltInCashReason = keyof typeof RETAIL_CASH_REASONS;
export const RETAIL_CASH_REASON_CODE = /^[a-z0-9_]{2,40}$/;
export const RETAIL_OVER_SHORT_ACCOUNT = "RETAIL-CASH-OVER-SHORT";

export const RETAIL_CASH_REASON_UNMAPPED = "RETAIL_CASH_REASON_UNMAPPED" as const;
export const RETAIL_CASH_REASON_UNMAPPED_MESSAGE =
  "This cash movement reason has no account mapped. Map the reason to an account in the Retail accounting settings first.";
export const RETAIL_CASH_REASON_DIRECTION_MESSAGE = "This reason cannot be used for this cash movement direction.";
export const RETAIL_CASH_AMOUNT_CENTS_MESSAGE = "A cash movement amount can have at most two decimals.";

export class RetailCashReasonUnmappedError extends HttpError {
  readonly code = RETAIL_CASH_REASON_UNMAPPED;
  constructor(readonly reasonCode: string) {
    super(409, RETAIL_CASH_REASON_UNMAPPED_MESSAGE);
    this.name = "RetailCashReasonUnmappedError";
  }
  get body() {
    return { code: this.code, message: this.message, reasonCode: this.reasonCode };
  }
}

export interface RetailCashReasonTarget {
  reasonCode: string;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  /** "mapping": a stored row; "default": the built-in default; "none": unmapped. */
  source: "mapping" | "default" | "none";
  direction: RetailCashDirection | "either";
  label: string | null;
}

function builtIn(reasonCode: string) {
  return Object.prototype.hasOwnProperty.call(RETAIL_CASH_REASONS, reasonCode)
    ? RETAIL_CASH_REASONS[reasonCode as RetailBuiltInCashReason]
    : null;
}

async function defaultTargetTx(
  tx: DbTransaction,
  companyId: number,
  target: string | null
): Promise<{ ledgerAccountId: number | null; bankAccountId: number | null }> {
  if (!target) return { ledgerAccountId: null, bankAccountId: null };
  if (target === "bank") {
    const settings = await ensureRetailAccountingSettingsTx(tx, companyId, null);
    return settings.bankAccountId
      ? { ledgerAccountId: null, bankAccountId: settings.bankAccountId }
      : { ledgerAccountId: settings.bankLedgerAccountId, bankAccountId: null };
  }
  return { ledgerAccountId: await retailSystemAccountIdTx(tx, companyId, target), bankAccountId: null };
}

/** Every built-in reason and every stored mapping of the company, with the account each resolves to. */
export async function listRetailCashReasonTargetsTx(
  tx: DbTransaction,
  companyId: number
): Promise<RetailCashReasonTarget[]> {
  const stored = await tx
    .select()
    .from(retailCashReasonAccounts)
    .where(eq(retailCashReasonAccounts.companyId, companyId));
  const byCode = new Map(stored.map((row) => [row.reasonCode, row]));
  const codes = [...new Set([...Object.keys(RETAIL_CASH_REASONS), ...stored.map((row) => row.reasonCode)])];
  const out: RetailCashReasonTarget[] = [];
  for (const reasonCode of codes) out.push(await resolveRetailCashReasonTx(tx, companyId, reasonCode, byCode));
  return out;
}

export async function resolveRetailCashReasonTx(
  tx: DbTransaction,
  companyId: number,
  reasonCode: string,
  storedByCode?: Map<string, typeof retailCashReasonAccounts.$inferSelect>
): Promise<RetailCashReasonTarget> {
  const known = builtIn(reasonCode);
  const row =
    storedByCode?.get(reasonCode) ??
    (storedByCode
      ? undefined
      : (
          await tx
            .select()
            .from(retailCashReasonAccounts)
            .where(
              and(
                eq(retailCashReasonAccounts.companyId, companyId),
                eq(retailCashReasonAccounts.reasonCode, reasonCode)
              )
            )
            .limit(1)
        )[0]);
  const direction = known?.direction ?? "either";
  const label = known?.label ?? null;
  if (row) {
    const mapped = row.ledgerAccountId != null || row.bankAccountId != null;
    return {
      reasonCode,
      ledgerAccountId: row.ledgerAccountId ?? null,
      bankAccountId: row.bankAccountId ?? null,
      source: mapped ? "mapping" : "none",
      direction,
      label,
    };
  }
  const target = await defaultTargetTx(tx, companyId, known?.defaultTarget ?? null);
  const mapped = target.ledgerAccountId != null || target.bankAccountId != null;
  return { reasonCode, ...target, source: mapped ? "default" : "none", direction, label };
}

export interface RetailCashReasonPatch {
  reasonCode: string;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
}

/**
 * Saves reason mappings (upsert by code), checking each account belongs to the
 * company, with one audit row (old and new targets) in the transaction. Both
 * targets null clears a mapping (the reason is then refused until mapped).
 */
export async function saveRetailCashReasonAccountsTx(
  tx: DbTransaction,
  companyId: number,
  patches: RetailCashReasonPatch[],
  actor: AuditActor & { userId: string | number }
): Promise<RetailCashReasonTarget[]> {
  const ledgerIds = [...new Set(patches.flatMap((patch) => (patch.ledgerAccountId ? [patch.ledgerAccountId] : [])))];
  const bankIds = [...new Set(patches.flatMap((patch) => (patch.bankAccountId ? [patch.bankAccountId] : [])))];
  if (patches.some((patch) => patch.ledgerAccountId && patch.bankAccountId)) {
    throw new HttpError(400, "A cash movement reason maps to one account: a ledger account or a bank account.");
  }
  if (ledgerIds.length) {
    const owned = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, ledgerIds)));
    if (owned.length !== ledgerIds.length)
      throw new HttpError(400, "One or more Retail ledger accounts belong to another company");
  }
  if (bankIds.length) {
    const owned = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), inArray(bankAccounts.id, bankIds)));
    if (owned.length !== bankIds.length) throw new HttpError(400, "Retail bank account belongs to another company");
  }
  const before = await listRetailCashReasonTargetsTx(tx, companyId);
  for (const patch of patches) {
    await tx
      .insert(retailCashReasonAccounts)
      .values({
        companyId,
        reasonCode: patch.reasonCode,
        ledgerAccountId: patch.ledgerAccountId,
        bankAccountId: patch.bankAccountId,
      })
      .onConflictDoUpdate({
        target: [retailCashReasonAccounts.companyId, retailCashReasonAccounts.reasonCode],
        set: { ledgerAccountId: patch.ledgerAccountId, bankAccountId: patch.bankAccountId, updatedAt: new Date() },
      });
  }
  const after = await listRetailCashReasonTargetsTx(tx, companyId);
  const pick = (rows: RetailCashReasonTarget[]) =>
    Object.fromEntries(
      rows.map((row) => [row.reasonCode, { ledgerAccountId: row.ledgerAccountId, bankAccountId: row.bankAccountId }])
    );
  const codes = [...new Set([...before, ...after].map((row) => row.reasonCode))];
  await writeAuditEvent(
    {
      ...actor,
      companyId,
      action: "update",
      tableName: "retail_cash_reason_accounts",
      recordId: null,
      recordIdentifier: "cash movement reason accounts",
      changes: buildAuditChanges(pick(before), pick(after), codes),
    },
    tx
  );
  return after;
}

/** True when a cash amount has at most two decimals. */
export function isCashAmountInCents(amount: Decimal): boolean {
  return amount.eq(amount.toDecimalPlaces(2));
}

/** The reason code a movement is checked against, before anything is written (400/409 when it cannot post). */
export async function assertRetailCashReasonPostableTx(
  tx: DbTransaction,
  companyId: number,
  reasonCode: string,
  movementType: RetailCashDirection
): Promise<RetailCashReasonTarget> {
  const target = await resolveRetailCashReasonTx(tx, companyId, reasonCode);
  if (target.direction !== "either" && target.direction !== movementType) {
    throw new HttpError(400, RETAIL_CASH_REASON_DIRECTION_MESSAGE);
  }
  if (target.source === "none") throw new RetailCashReasonUnmappedError(reasonCode);
  return target;
}

/** The shift's cash account: the one it was opened with, else the Retail cash account of its register. */
async function shiftCashAccountTx(
  tx: DbTransaction,
  companyId: number,
  shift: { locationId: number; cashAccountId: number | null }
): Promise<number> {
  if (shift.cashAccountId) return shift.cashAccountId;
  return (await ensureRetailAccountingSettingsTx(tx, companyId, shift.locationId)).cashLedgerAccountId;
}

/** Posts a movement's journal in its transaction and links it to the movement. */
export async function postRetailCashMovementTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    shift: { id: number; locationId: number; cashAccountId: number | null };
    movement: { id: number; movementType: RetailCashDirection; amount: Decimal.Value; reason: string };
    target: RetailCashReasonTarget;
    actor: RetailJournalActor;
  }
): Promise<number | null> {
  const cash = await shiftCashAccountTx(tx, input.companyId, input.shift);
  const amount = cents(input.movement.amount);
  const signed = input.movement.movementType === "cash_in" ? amount : amount.negated();
  const voucherId = await postRetailJournalTx(tx, {
    companyId: input.companyId,
    locationId: input.shift.locationId,
    voucherNumber: `RETAIL-CASH-${input.movement.id}`,
    sourceType: "retail-cash-movement",
    sourceId: String(input.movement.id),
    description: `Retail shift #${input.shift.id} ${input.movement.movementType} · ${input.target.reasonCode}`,
    lines: [
      { ledgerAccountId: cash, amount: signed, narration: `Shift #${input.shift.id} cash · ${input.movement.reason}` },
      {
        ledgerAccountId: input.target.ledgerAccountId,
        bankAccountId: input.target.bankAccountId,
        amount: signed.negated(),
        narration: `Shift #${input.shift.id} ${input.target.reasonCode} · ${input.movement.reason}`,
      },
    ],
    actor: input.actor,
    reason: "Retail cash movement",
  });
  if (voucherId) {
    await tx
      .update(retailCashMovements)
      .set({ voucherId })
      .where(and(eq(retailCashMovements.id, input.movement.id), eq(retailCashMovements.companyId, input.companyId)));
  }
  return voucherId;
}

/**
 * The Cash Over/Short journal of a closed Retail shift: variance = counted −
 * expected. Nothing when it is zero to the cent. In the close's transaction.
 */
export async function postRetailShiftOverShortTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    shift: { id: number; locationId: number; cashAccountId: number | null };
    variance: Decimal.Value;
    actor: RetailJournalActor;
  }
): Promise<number | null> {
  const variance = cents(toMoney(input.variance));
  if (variance.isZero()) return null;
  const cash = await shiftCashAccountTx(tx, input.companyId, input.shift);
  const overShort = await retailSystemAccountIdTx(tx, input.companyId, RETAIL_OVER_SHORT_ACCOUNT);
  const over = variance.gt(0);
  return postRetailJournalTx(tx, {
    companyId: input.companyId,
    locationId: input.shift.locationId,
    voucherNumber: `RETAIL-OVERSHORT-${input.shift.id}`,
    sourceType: "retail-shift-over-short",
    sourceId: String(input.shift.id),
    description: `Retail shift #${input.shift.id} cash over/short ${variance.toFixed(2)}`,
    lines: [
      { ledgerAccountId: cash, amount: variance, narration: `Shift #${input.shift.id} counted less expected cash` },
      {
        ledgerAccountId: overShort,
        amount: variance.negated(),
        narration: `Shift #${input.shift.id} cash ${over ? "over" : "short"}`,
      },
    ],
    actor: input.actor,
    reason: "Retail shift close cash over/short",
  });
}
