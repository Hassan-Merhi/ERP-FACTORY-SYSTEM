// Extracted from ./paymentSync.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  bankAccounts,
  companies,
  intercompanyImportBatchContainers,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  ledgerAccounts,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { normalizeCurrencyCode } from "../accounting/currencyAmounts";
import { type EditIdentity, postingDay, rejectEdit, validateRequestKey } from "./tradeSync";
import { cents } from "./tradeRevisionMath";
import { requirePairedCashAuthorization } from "./pairedPaymentAuthorization";
import {
  exactManualAllocation,
  paymentBaseAmount,
  type PaymentCurrency,
  paymentHistoricalRate,
  paymentMoney,
} from "./paymentMoney";
import { tradeAppliedTx } from "./paymentAllocationCore";

export type CashRef = { type: "bank" | "cash"; id: number };

export type ManualPoChoice = { tradeId: number; expectedVersion: number; amount: string };

export type MirroredPaymentInput = {
  relationshipId: number;
  requestKey: string;
  paymentDate: string;
  currency: PaymentCurrency;
  transactionAmount: string;
  historicalRate: string;
  sourceReceiptAccount: CashRef;
  destinationPaymentAccount: CashRef;
  transferReference: string;
  confirmationEvidence: string;
  reason: string;
  confirmedSourceReceipt: boolean;
  confirmedDestinationPayment: boolean;
  allocations: ManualPoChoice[];
};

type Policy = typeof intercompanyRelationshipPolicies.$inferSelect;

export function validatePayment(input: MirroredPaymentInput) {
  postingDay(input.paymentDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.relationshipId) ||
    input.relationshipId < 1 ||
    !input.confirmedSourceReceipt ||
    !input.confirmedDestinationPayment ||
    !input.transferReference ||
    input.transferReference.trim().length < 5 ||
    input.transferReference.length > 180 ||
    !input.confirmationEvidence ||
    input.confirmationEvidence.trim().length < 8 ||
    input.confirmationEvidence.length > 2000 ||
    !input.reason?.trim() ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000 ||
    !Array.isArray(input.allocations) ||
    input.allocations.length > 200
  ) {
    rejectEdit(
      "Both real money movements, original bank evidence and a reason require explicit confirmation",
      "IC_PAYMENT_EVIDENCE",
      422
    );
  }
  let currency: PaymentCurrency;
  try {
    currency = normalizeCurrencyCode(input.currency) as PaymentCurrency;
  } catch {
    rejectEdit("Use a supported historical currency", "IC_PAYMENT_CURRENCY", 422);
  }
  if (currency !== input.currency) rejectEdit("Use the canonical ERP currency", "IC_PAYMENT_CURRENCY", 422);
  let native, rate, base;
  try {
    native = paymentMoney(input.transactionAmount);
    rate = paymentHistoricalRate(currency, input.historicalRate);
    base = paymentBaseAmount(currency, input.transactionAmount, input.historicalRate);
  } catch (error) {
    rejectEdit(error instanceof Error ? error.message : "Invalid monetary amount", "IC_PAYMENT_MONEY", 422);
  }
  const unique = new Set(input.allocations.map((x) => x.tradeId));
  if (unique.size !== input.allocations.length)
    rejectEdit("Each chosen PO may appear only once", "IC_PAYMENT_DUPLICATE_PO", 422);
  for (const item of input.allocations) {
    if (
      !Number.isSafeInteger(item.tradeId) ||
      item.tradeId < 1 ||
      !Number.isSafeInteger(item.expectedVersion) ||
      item.expectedVersion < 1 ||
      typeof item.amount !== "string" ||
      !/^\d+(?:\.\d{1,2})?$/.test(item.amount) ||
      !cents(item.amount).gt(0)
    ) {
      rejectEdit("PO allocation must be positive, cent-exact and versioned", "IC_PAYMENT_ALLOCATION", 422);
    }
  }
  exactManualAllocation(
    base,
    input.allocations.map((a) => cents(a.amount)),
    input.allocations.map(() => base)
  );
  return { native, rate, base, currency };
}

export function accountTarget(ref: CashRef): Pick<ErpVoucherLine, "bankAccountId" | "ledgerAccountId"> {
  return ref.type === "bank" ? { bankAccountId: ref.id } : { ledgerAccountId: ref.id };
}

export async function checkAccount(tx: DbTransaction, companyId: number, ref: CashRef) {
  if (!ref || !Number.isSafeInteger(ref.id) || ref.id < 1 || !["bank", "cash"].includes(ref.type)) {
    rejectEdit("Choose active cash/bank accounts for both companies", "IC_PAYMENT_ACCOUNT", 422);
  }
  if (ref.type === "bank") {
    const [row] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, ref.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      );
    if (!row) rejectEdit("Selected bank account is not available in the correct company", "IC_PAYMENT_ACCOUNT", 422);
  } else {
    const [row] = await tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.id, ref.id),
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, "Cash"),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    if (!row) rejectEdit("Selected cash account is not available in the correct company", "IC_PAYMENT_ACCOUNT", 422);
  }
}

export async function accessiblePaymentPair(relationshipId: number, actor: EditIdentity, requireEnabled = true) {
  if (!Number.isSafeInteger(relationshipId) || relationshipId < 1)
    rejectEdit("Invalid company relationship", "IC_PAYMENT_PAIR", 422);
  const [pair] = await db
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, relationshipId));
  if (
    !pair ||
    pair.relationshipType !== "container_trade" ||
    (requireEnabled && !pair.tradeEnabled) ||
    ![pair.sourceCompanyId, pair.destinationCompanyId].includes(actor.initiatingCompanyId)
  ) {
    rejectEdit("No active paired intercompany payment relation in your company", "IC_PAYMENT_PAIR", 403);
  }
  // Even a developer must have explicit finance membership in both companies
  // before reading paired cash details or posting either bank/cash leg.
  await requirePairedCashAuthorization(pair, actor);
  return pair;
}

export async function activePaymentPairTx(tx: DbTransaction, id: number) {
  const [pair] = await tx
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, id))
    .for("update");
  if (
    !pair ||
    pair.relationshipType !== "container_trade" ||
    !pair.tradeEnabled ||
    !pair.sourceReceivableAccountId ||
    !pair.destinationSupplierId
  ) {
    rejectEdit("Pair is disabled or lacks verified receivable and supplier mappings");
  }
  const rows = await tx
    .select()
    .from(companies)
    .where(inArray(companies.id, [pair.sourceCompanyId, pair.destinationCompanyId]));
  const source = rows.find((c) => c.id === pair.sourceCompanyId),
    dest = rows.find((c) => c.id === pair.destinationCompanyId);
  if (
    !source ||
    !dest ||
    !source.active ||
    !dest.active ||
    source.companyType !== "properties" ||
    dest.companyType !== "erp" ||
    (source.baseCurrency ?? "USD") !== "USD" ||
    (dest.baseCurrency ?? "USD") !== "USD"
  ) {
    rejectEdit("Paired payment requires active USD-base Properties and ERP companies");
  }
  const [destinationSupplier] = await tx
    .select()
    .from(companyScopedSuppliers)
    .where(
      and(
        eq(companyScopedSuppliers.id, pair.destinationSupplierId!),
        eq(companyScopedSuppliers.companyId, pair.destinationCompanyId),
        eq(companyScopedSuppliers.active, true),
        isNull(companyScopedSuppliers.deletedAt)
      )
    );
  const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!destinationSupplier || normalizeName(destinationSupplier.legalName) !== normalizeName(source.name)) {
    rejectEdit("The destination intercompany supplier must represent the original Properties company");
  }
  return pair;
}

export async function checkChosenPos(tx: DbTransaction, pair: Policy, choices: ManualPoChoice[], base: string) {
  const amounts = choices.map((c) => cents(c.amount)),
    available = [];
  for (const choice of choices) {
    const [trade] = await tx.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, choice.tradeId));
    if (
      !trade ||
      trade.state !== "active" ||
      trade.relationshipId !== pair.id ||
      trade.sourceCompanyId !== pair.sourceCompanyId ||
      trade.destinationCompanyId !== pair.destinationCompanyId
    ) {
      rejectEdit(
        "A chosen PO belongs to another pair, so its money cannot be moved here",
        "IC_PAYMENT_WRONG_PAIR",
        409
      );
    }
    if (trade.version !== choice.expectedVersion)
      rejectEdit("PO changed; refresh allocation before confirmation", "IC_PAYMENT_PO_STALE");
    const [posted] = await tx
      .select()
      .from(intercompanyImportBatchContainers)
      .where(eq(intercompanyImportBatchContainers.tradeId, trade.id));
    if (!posted || posted.confirmedLandedCost == null) rejectEdit("Selected PO has no confirmed landed cost");
    const due = cents(posted.confirmedLandedCost).minus(await tradeAppliedTx(tx, trade.id));
    if (due.lt(0)) rejectEdit("Selected PO has inconsistent prior allocations");
    available.push(due);
  }
  exactManualAllocation(cents(base), amounts, available);
}
