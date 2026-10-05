import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  companies,
  ledgerAccounts,
  retailAccountMappings,
  retailAccountingPostings,
  type RetailAccountKey,
  type RetailPaymentMethod,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { postBalancedVoucherTx, type CentralPostingRequest } from "../accounting/centralPostingEngine";
import { normalizeCurrencyCode, normalizeVoucherEntryAmounts } from "../accounting/currencyAmounts";
import { retailMoney, retailDecimal } from "./retailFinancialMath";

export type RetailAccountingPostingType = "sale" | "return" | "cancellation";

export interface RetailAccountingAmounts {
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  cogsAmount: string;
}

export interface RetailAccountingPaymentLine {
  method: RetailPaymentMethod;
  /** Positive for a sale and negative for a refund/cancellation. */
  amount: string;
}

export type RetailAccountMap = Record<RetailAccountKey, number>;

const ACCOUNT_KEYS: readonly RetailAccountKey[] = [
  "cash",
  "card_clearing",
  "bank",
  "sales_revenue",
  "inventory_asset",
  "cogs",
  "discounts",
  "tax_payable",
  "store_credit_liability",
];

const PAYMENT_ACCOUNT: Record<RetailPaymentMethod, RetailAccountKey> = {
  cash: "cash",
  card: "card_clearing",
  bank_transfer: "bank",
  mobile_other: "card_clearing",
  store_credit: "store_credit_liability",
};

export function paymentAccountKey(method: RetailPaymentMethod): RetailAccountKey {
  return PAYMENT_ACCOUNT[method];
}

function positiveMoney(value: string): Decimal {
  return new Decimal(retailMoney(value));
}

/** Build the exact double-entry lines used for a Retail sale or reversal. */
export function buildRetailAccountingEntries(input: {
  saleId: number;
  postingType: RetailAccountingPostingType;
  amounts: RetailAccountingAmounts;
  payments: RetailAccountingPaymentLine[];
  accounts: RetailAccountMap;
}) {
  const { saleId, postingType, amounts, payments, accounts } = input;
  const reversal = postingType !== "sale";
  const entries: CentralPostingRequest["entries"] = [];
  let debitTotal = new Decimal(0);

  const add = (key: RetailAccountKey, side: "debit" | "credit", value: string, description: string) => {
    const amount = positiveMoney(value);
    if (amount.lte(0)) return;
    if (side === "debit") debitTotal = debitTotal.plus(amount);
    entries.push({
      ledgerAccountId: accounts[key],
      debitAmount: side === "debit" ? amount.toFixed(2) : "0.00",
      creditAmount: side === "credit" ? amount.toFixed(2) : "0.00",
      narration: `Retail Sale #${saleId} — ${description}`,
    });
  };

  for (const payment of payments) {
    const amount = retailDecimal(payment.amount, "payment amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const account = paymentAccountKey(payment.method);
    if (amount.isZero()) continue;
    if (reversal) {
      if (amount.gte(0)) throw new Error("Retail reversal payment entries must be negative");
      add(account, "credit", amount.abs().toFixed(2), `${postingType} refund via ${payment.method}`);
    } else {
      if (amount.lte(0)) throw new Error("Retail sale payment entries must be positive");
      add(account, "debit", amount.toFixed(2), `sale payment via ${payment.method}`);
    }
  }

  const subtotal = retailMoney(amounts.subtotalAmount);
  const discount = retailMoney(amounts.discountAmount);
  const tax = retailMoney(amounts.taxAmount);
  const cogs = retailMoney(amounts.cogsAmount);
  if (reversal) {
    add("sales_revenue", "debit", subtotal, `${postingType} revenue reversal`);
    add("discounts", "credit", discount, `${postingType} discount reversal`);
    add("tax_payable", "debit", tax, `${postingType} tax reversal`);
    add("inventory_asset", "debit", cogs, `${postingType} inventory restored`);
    add("cogs", "credit", cogs, `${postingType} cost reversal`);
  } else {
    add("sales_revenue", "credit", subtotal, "sales revenue");
    add("discounts", "debit", discount, "sales discount");
    add("tax_payable", "credit", tax, "sales tax payable");
    add("cogs", "debit", cogs, "cost of goods sold");
    add("inventory_asset", "credit", cogs, "inventory relieved");
  }

  return { entries, debitTotal: debitTotal.toFixed(2) };
}

export async function loadRetailAccountMap(tx: DbTransaction, companyId: number): Promise<RetailAccountMap> {
  const rows = await tx
    .select({ accountKey: retailAccountMappings.accountKey, ledgerAccountId: retailAccountMappings.ledgerAccountId })
    .from(retailAccountMappings)
    .where(eq(retailAccountMappings.companyId, companyId));
  const values = new Map(rows.map((row) => [row.accountKey, row.ledgerAccountId]));
  const missing = ACCOUNT_KEYS.filter((key) => !values.has(key));
  if (missing.length) {
    throw new Error(`Retail accounting is not configured. Map these accounts first: ${missing.join(", ")}`);
  }
  const accountIds = [...new Set(ACCOUNT_KEYS.map((key) => values.get(key)!))];
  const active = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        inArray(ledgerAccounts.id, accountIds)
      )
    );
  const activeIds = new Set(active.map((row) => row.id));
  const stale = ACCOUNT_KEYS.filter((key) => !activeIds.has(values.get(key)!));
  if (stale.length)
    throw new Error(`Retail account mappings contain inactive or foreign accounts: ${stale.join(", ")}`);
  return Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, values.get(key)!])) as RetailAccountMap;
}

export async function postRetailAccountingEventTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    saleId: number;
    locationId: number;
    referenceKey: string;
    postingType: RetailAccountingPostingType;
    amounts: RetailAccountingAmounts;
    payments: RetailAccountingPaymentLine[];
    userId: string;
    username?: string | null;
    occurredAt?: Date;
  }
): Promise<{ voucherId: number; replayed: boolean }> {
  const [existing] = await tx
    .select({ voucherId: retailAccountingPostings.voucherId })
    .from(retailAccountingPostings)
    .where(
      and(
        eq(retailAccountingPostings.companyId, input.companyId),
        eq(retailAccountingPostings.referenceKey, input.referenceKey)
      )
    )
    .limit(1);
  if (existing) return { voucherId: existing.voucherId, replayed: true };

  const accounts = await loadRetailAccountMap(tx, input.companyId);
  const built = buildRetailAccountingEntries({
    saleId: input.saleId,
    postingType: input.postingType,
    amounts: input.amounts,
    payments: input.payments,
    accounts,
  });
  if (built.entries.length < 2 || positiveMoney(built.debitTotal).lte(0)) {
    throw new Error("Retail accounting event does not contain balanced financial activity");
  }
  const [company] = await tx
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!company) throw new Error("Retail company was not found for accounting posting");
  const currency = normalizeCurrencyCode(company.baseCurrency || "USD");
  if (currency !== "USD" && currency !== "CFA") {
    throw new Error(`Retail accounting does not support company base currency ${currency}`);
  }
  const normalizedEntries: CentralPostingRequest["entries"] = built.entries.map((entry) => {
    const normalized = normalizeVoucherEntryAmounts({
      transactionCurrency: currency,
      baseCurrency: currency,
      transactionDebitAmount: entry.debitAmount ?? "0",
      transactionCreditAmount: entry.creditAmount ?? "0",
      historicalRate: null,
    });
    return {
      ...entry,
      debitAmount: normalized.debitAmount,
      creditAmount: normalized.creditAmount,
      transactionCurrency: normalized.transactionCurrency,
      transactionDebitAmount: normalized.transactionDebitAmount,
      transactionCreditAmount: normalized.transactionCreditAmount,
      baseDebitAmount: normalized.baseDebitAmount,
      baseCreditAmount: normalized.baseCreditAmount,
      historicalExchangeRate: normalized.historicalExchangeRate,
      rateConvention: normalized.rateConvention,
    };
  });

  const occurredAt = input.occurredAt ?? new Date();
  const voucherDate = occurredAt.toISOString().slice(0, 10);
  const sourceType = `retail-${input.postingType}`;
  const sourceId = `${input.referenceKey}`;
  const idempotencyKey = `retail:${input.companyId}:${input.referenceKey}`;
  const request: CentralPostingRequest = {
    voucher: {
      companyId: input.companyId,
      locationId: input.locationId,
      voucherNumber: `RTL-${input.companyId}-${input.referenceKey.replace(/[^A-Za-z0-9-]/g, "-")}`.slice(0, 100),
      voucherType: "Journal",
      voucherDate,
      effectiveDate: voucherDate,
      totalAmount: built.debitTotal,
      description: `Retail Sale #${input.saleId} ${input.postingType} · ${input.referenceKey}`,
      currency,
      sourceModule: "ERP",
    },
    entries: normalizedEntries,
    source: { sourceType, sourceId, idempotencyKey },
    actor: { userId: input.userId, username: input.username ?? null, reason: `Retail Sale #${input.saleId}` },
  };

  const posted = await postBalancedVoucherTx(tx, request, createDatabasePostingDependencies());
  const [bridgeRow] = await tx
    .insert(retailAccountingPostings)
    .values({
      companyId: input.companyId,
      saleId: input.saleId,
      referenceKey: input.referenceKey,
      postingType: input.postingType,
      accountSnapshot: accounts,
      voucherId: posted.voucher.id,
      subtotalAmount: retailMoney(input.amounts.subtotalAmount),
      discountAmount: retailMoney(input.amounts.discountAmount),
      taxAmount: retailMoney(input.amounts.taxAmount),
      totalAmount: retailMoney(input.amounts.totalAmount),
      cogsAmount: retailMoney(input.amounts.cogsAmount),
      createdBy: input.userId,
      createdAt: occurredAt,
    })
    .onConflictDoNothing({ target: [retailAccountingPostings.companyId, retailAccountingPostings.referenceKey] })
    .returning({ voucherId: retailAccountingPostings.voucherId });

  if (!bridgeRow) {
    const [previous] = await tx
      .select({ voucherId: retailAccountingPostings.voucherId })
      .from(retailAccountingPostings)
      .where(
        and(
          eq(retailAccountingPostings.companyId, input.companyId),
          eq(retailAccountingPostings.referenceKey, input.referenceKey)
        )
      )
      .limit(1);
    if (!previous || previous.voucherId !== posted.voucher.id) {
      throw new Error("Retail accounting reference is already attached to a different voucher");
    }
  }

  return { voucherId: posted.voucher.id, replayed: posted.replayed };
}

export async function loadRetailAccountMappings(companyId: number) {
  return db
    .select({
      accountKey: retailAccountMappings.accountKey,
      ledgerAccountId: retailAccountMappings.ledgerAccountId,
      accountName: ledgerAccounts.name,
      accountCode: ledgerAccounts.code,
      active: ledgerAccounts.active,
    })
    .from(retailAccountMappings)
    .innerJoin(
      ledgerAccounts,
      and(
        eq(ledgerAccounts.id, retailAccountMappings.ledgerAccountId),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true)
      )
    )
    .where(eq(retailAccountMappings.companyId, companyId));
}

export function calculateRetailCogs(lines: Array<{ quantity: string; unitCost: string }>): string {
  const total = lines.reduce((sum, line) => {
    const amount = retailDecimal(line.quantity).mul(retailDecimal(line.unitCost));
    return sum.plus(amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }, new Decimal(0));
  return total.toFixed(2);
}
