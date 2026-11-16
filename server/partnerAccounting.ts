import Decimal from "decimal.js";

export type MoneyInput = string | number;

export type PostingAccount =
  { kind: "ledger"; id: number; name?: string } | { kind: "bank"; id: number; name?: string };

export type Phase1VoucherType = "Receipt" | "Payment" | "Journal" | "Contra" | "Sales";

export interface Phase1VoucherEntry {
  ledgerAccountId?: number;
  bankAccountId?: number;
  debitAmount: string;
  creditAmount: string;
  narration: string;
}

export interface Phase1VoucherDraft {
  voucherType: Phase1VoucherType;
  totalAmount: string;
  locationId?: number;
  description: string;
  entries: Phase1VoucherEntry[];
}

export interface ContainerReservePlan {
  reserveUsd: string;
  expectedDutyUsd: string;
  expectedTransportUsd: string;
  expectedTotalUsd: string;
  reserveHeadroomUsd: string;
}

export interface FundingAllocationPlan {
  fundingBalanceUsd: string;
  inventoryInTransitUsd: string;
  containerReserveUsd: string;
  savingsAvailableUsd: string;
}

export interface SaleEconomics {
  quantity: string;
  revenueUsd: string;
  cogsUsd: string;
  grossProfitUsd: string;
}

export class Phase1AccountingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase1AccountingValidationError";
  }
}

function decimal(value: MoneyInput, fieldName: string): Decimal {
  const result = new Decimal(value);
  if (!result.isFinite()) {
    throw new Phase1AccountingValidationError(`${fieldName} must be a finite number`);
  }
  return result;
}

function positive(value: MoneyInput, fieldName: string): Decimal {
  const result = decimal(value, fieldName);
  if (result.lte(0)) {
    throw new Phase1AccountingValidationError(`${fieldName} must be greater than zero`);
  }
  return result;
}

function nonNegative(value: MoneyInput, fieldName: string): Decimal {
  const result = decimal(value, fieldName);
  if (result.lt(0)) {
    throw new Phase1AccountingValidationError(`${fieldName} cannot be negative`);
  }
  return result;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function validateAccount(account: PostingAccount, fieldName: string): void {
  if (!Number.isInteger(account.id) || account.id <= 0) {
    throw new Phase1AccountingValidationError(`${fieldName} must reference a positive account id`);
  }
}

function accountFields(account: PostingAccount): Pick<Phase1VoucherEntry, "ledgerAccountId" | "bankAccountId"> {
  validateAccount(account, "account");
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

function debit(account: PostingAccount, amount: Decimal, narration: string): Phase1VoucherEntry {
  return {
    ...accountFields(account),
    debitAmount: money(amount),
    creditAmount: "0.00",
    narration,
  };
}

function credit(account: PostingAccount, amount: Decimal, narration: string): Phase1VoucherEntry {
  return {
    ...accountFields(account),
    debitAmount: "0.00",
    creditAmount: money(amount),
    narration,
  };
}

export function assertBalancedPhase1Voucher(voucher: Phase1VoucherDraft): Phase1VoucherDraft {
  if (voucher.entries.length < 2) {
    throw new Phase1AccountingValidationError("A Phase 1 voucher must contain at least two entries");
  }
  if (voucher.locationId !== undefined && (!Number.isInteger(voucher.locationId) || voucher.locationId <= 0)) {
    throw new Phase1AccountingValidationError("locationId must be a positive integer when supplied");
  }

  let debits = new Decimal(0);
  let credits = new Decimal(0);

  for (const [index, entry] of voucher.entries.entries()) {
    const debitAmount = nonNegative(entry.debitAmount, `entries[${index}].debitAmount`);
    const creditAmount = nonNegative(entry.creditAmount, `entries[${index}].creditAmount`);
    const accountCount = Number(entry.ledgerAccountId !== undefined) + Number(entry.bankAccountId !== undefined);

    if (accountCount !== 1) {
      throw new Phase1AccountingValidationError(`entries[${index}] must reference exactly one ledger or bank account`);
    }
    if (debitAmount.gt(0) === creditAmount.gt(0)) {
      throw new Phase1AccountingValidationError(
        `entries[${index}] must contain either a debit or a credit, but not both`
      );
    }

    debits = debits.plus(debitAmount);
    credits = credits.plus(creditAmount);
  }

  if (!debits.eq(credits)) {
    throw new Phase1AccountingValidationError(
      `Voucher is not balanced: debits ${money(debits)} do not equal credits ${money(credits)}`
    );
  }

  return voucher;
}

function finalizeVoucher(voucher: Phase1VoucherDraft): Phase1VoucherDraft {
  return assertBalancedPhase1Voucher(voucher);
}

export function buildPartnerCashContributionVoucher(input: {
  amountUsd: MoneyInput;
  cashAccount: PostingAccount;
  partnerCapitalAccount: PostingAccount;
  partnerName: string;
}): Phase1VoucherDraft {
  const amount = positive(input.amountUsd, "amountUsd");
  const description = `${input.partnerName} cash contribution`;

  return finalizeVoucher({
    voucherType: "Receipt",
    totalAmount: money(amount),
    description,
    entries: [debit(input.cashAccount, amount, description), credit(input.partnerCapitalAccount, amount, description)],
  });
}

export function buildInventoryInTransitContributionVoucher(input: {
  goodsCostUsd: MoneyInput;
  stockOtwAccount: PostingAccount;
  partnerCapitalAccount: PostingAccount;
  partnerName: string;
  containerReference?: string;
}): Phase1VoucherDraft {
  const amount = positive(input.goodsCostUsd, "goodsCostUsd");
  const reference = input.containerReference ? ` (${input.containerReference})` : "";
  const description = `${input.partnerName} inventory contribution - Stock OTW${reference}`;

  return finalizeVoucher({
    voucherType: "Journal",
    totalAmount: money(amount),
    description,
    entries: [
      debit(input.stockOtwAccount, amount, description),
      credit(input.partnerCapitalAccount, amount, description),
    ],
  });
}

export function buildContainerReservePlan(input: {
  reserveUsd: MoneyInput;
  expectedDutyUsd: MoneyInput;
  expectedTransportUsd: MoneyInput;
}): ContainerReservePlan {
  const reserve = nonNegative(input.reserveUsd, "reserveUsd");
  const duty = nonNegative(input.expectedDutyUsd, "expectedDutyUsd");
  const transport = nonNegative(input.expectedTransportUsd, "expectedTransportUsd");
  const expectedTotal = duty.plus(transport);

  if (expectedTotal.gt(reserve)) {
    throw new Phase1AccountingValidationError(
      `Container reserve is short by ${money(expectedTotal.minus(reserve))}; increase the reserve before allocating the remainder to savings`
    );
  }

  return {
    reserveUsd: money(reserve),
    expectedDutyUsd: money(duty),
    expectedTransportUsd: money(transport),
    expectedTotalUsd: money(expectedTotal),
    reserveHeadroomUsd: money(reserve.minus(expectedTotal)),
  };
}

export function buildFundingAllocationPlan(input: {
  fundingBalanceUsd: MoneyInput;
  inventoryInTransitUsd: MoneyInput;
  containerReserveUsd: MoneyInput;
}): FundingAllocationPlan {
  const funding = nonNegative(input.fundingBalanceUsd, "fundingBalanceUsd");
  const stockOtw = nonNegative(input.inventoryInTransitUsd, "inventoryInTransitUsd");
  const reserve = nonNegative(input.containerReserveUsd, "containerReserveUsd");
  const savings = funding.minus(stockOtw).minus(reserve);

  if (savings.lt(0)) {
    throw new Phase1AccountingValidationError(
      `Funding allocation exceeds the available balance by ${money(savings.abs())}`
    );
  }

  return {
    fundingBalanceUsd: money(funding),
    inventoryInTransitUsd: money(stockOtw),
    containerReserveUsd: money(reserve),
    savingsAvailableUsd: money(savings),
  };
}

export function buildContainerCostPaymentVoucher(input: {
  amountUsd: MoneyInput;
  stockOtwAccount: PostingAccount;
  paymentAccount: PostingAccount;
  chargeLabel: string;
  containerReference?: string;
}): Phase1VoucherDraft {
  const amount = positive(input.amountUsd, "amountUsd");
  const reference = input.containerReference ? ` (${input.containerReference})` : "";
  const description = `${input.chargeLabel} capitalized to Stock OTW${reference}`;

  return finalizeVoucher({
    voucherType: "Payment",
    totalAmount: money(amount),
    description,
    entries: [debit(input.stockOtwAccount, amount, description), credit(input.paymentAccount, amount, description)],
  });
}

export function buildContainerOffloadVoucher(input: {
  totalLandedCostUsd: MoneyInput;
  inventoryAccount: PostingAccount;
  stockOtwAccount: PostingAccount;
  locationId: number;
  containerReference?: string;
}): Phase1VoucherDraft {
  const amount = positive(input.totalLandedCostUsd, "totalLandedCostUsd");
  const reference = input.containerReference ? ` (${input.containerReference})` : "";
  const description = `Container offload from Stock OTW to inventory${reference}`;

  return finalizeVoucher({
    voucherType: "Journal",
    totalAmount: money(amount),
    locationId: input.locationId,
    description,
    entries: [debit(input.inventoryAccount, amount, description), credit(input.stockOtwAccount, amount, description)],
  });
}

export function buildSavingsTransferVoucher(input: {
  amountUsd: MoneyInput;
  operatingCashAccount: PostingAccount;
  savingsAccount: PostingAccount;
}): Phase1VoucherDraft {
  const amount = positive(input.amountUsd, "amountUsd");
  const description = "Transfer available cash to owner-controlled savings";

  return finalizeVoucher({
    voucherType: "Contra",
    totalAmount: money(amount),
    description,
    entries: [
      debit(input.savingsAccount, amount, description),
      credit(input.operatingCashAccount, amount, description),
    ],
  });
}

export function buildOwnerWithdrawalVoucher(input: {
  amountUsd: MoneyInput;
  ownerDrawingsAccount: PostingAccount;
  paymentAccount: PostingAccount;
  ownerName: string;
}): Phase1VoucherDraft {
  const amount = positive(input.amountUsd, "amountUsd");
  const description = `${input.ownerName} owner withdrawal`;

  return finalizeVoucher({
    voucherType: "Payment",
    totalAmount: money(amount),
    description,
    entries: [
      debit(input.ownerDrawingsAccount, amount, description),
      credit(input.paymentAccount, amount, description),
    ],
  });
}

export function calculateSaleEconomics(input: {
  quantity: MoneyInput;
  salePricePerUnitUsd: MoneyInput;
  inventoryCostPerUnitUsd: MoneyInput;
}): SaleEconomics {
  const quantity = positive(input.quantity, "quantity");
  const price = nonNegative(input.salePricePerUnitUsd, "salePricePerUnitUsd");
  const cost = nonNegative(input.inventoryCostPerUnitUsd, "inventoryCostPerUnitUsd");
  const revenue = quantity.times(price);
  const cogs = quantity.times(cost);

  return {
    quantity: quantity.toString(),
    revenueUsd: money(revenue),
    cogsUsd: money(cogs),
    grossProfitUsd: money(revenue.minus(cogs)),
  };
}

export function buildLocationSaleVoucher(input: {
  quantity: MoneyInput;
  salePricePerUnitUsd: MoneyInput;
  inventoryCostPerUnitUsd: MoneyInput;
  locationId: number;
  cashOrReceivableAccount: PostingAccount;
  salesRevenueAccount: PostingAccount;
  cogsAccount: PostingAccount;
  inventoryAccount: PostingAccount;
  description?: string;
}): Phase1VoucherDraft {
  const economics = calculateSaleEconomics(input);
  const revenue = positive(economics.revenueUsd, "revenueUsd");
  const cogs = nonNegative(economics.cogsUsd, "cogsUsd");
  const description = input.description ?? `Location ${input.locationId} sale`;

  const entries: Phase1VoucherEntry[] = [
    debit(input.cashOrReceivableAccount, revenue, `${description} - proceeds`),
    credit(input.salesRevenueAccount, revenue, `${description} - revenue`),
  ];

  if (cogs.gt(0)) {
    entries.push(
      debit(input.cogsAccount, cogs, `${description} - cost of goods sold`),
      credit(input.inventoryAccount, cogs, `${description} - inventory relief`)
    );
  }

  return finalizeVoucher({
    voucherType: "Sales",
    totalAmount: economics.revenueUsd,
    locationId: input.locationId,
    description,
    entries,
  });
}
