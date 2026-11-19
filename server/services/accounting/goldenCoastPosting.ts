import type { PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest, type BuiltGenericVoucherPosting } from "./genericVoucherPosting";
import {
  buildContainerCostPaymentVoucher,
  buildContainerOffloadVoucher,
  buildContainerReservePlan,
  buildFundingAllocationPlan,
  buildInventoryInTransitContributionVoucher,
  buildLocationSaleVoucher,
  buildOwnerWithdrawalVoucher,
  buildPartnerCashContributionVoucher,
  buildSavingsTransferVoucher,
  calculateSaleEconomics,
  type MoneyInput,
  type Phase1VoucherDraft,
  type PostingAccount,
} from "../../partnerAccounting";

export const GOLDEN_COAST_PHASE1_ACCOUNT_DEFS = [
  { code: "SP-OTW", name: "Goods On The Way", accountType: "Asset", subType: "sp_goods_otw" },
  { code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset", subType: "sp_stock" },
  { code: "SP-SALES", name: "Sales", accountType: "Income", subType: "sp_sales" },
  { code: "SP-COGS", name: "Cost of Goods Sold", accountType: "Direct Expense", subType: "sp_cogs" },
  { code: "GC-FSCAP", name: "Fresh Start Capital", accountType: "Equity", subType: "gc_partner_capital" },
  { code: "GC-HCAP", name: "Hassan Capital", accountType: "Equity", subType: "gc_owner_capital" },
  { code: "GC-HDRAW", name: "Hassan Drawings", accountType: "Equity", subType: "gc_owner_drawings" },
] as const;

export const GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES: string[] = GOLDEN_COAST_PHASE1_ACCOUNT_DEFS.map(
  (account) => account.subType
);

export type GoldenCoastPhase1EventType =
  | "partner_cash_contribution"
  | "inventory_in_transit_contribution"
  | "container_reserve_plan"
  | "funding_allocation_plan"
  | "container_cost_payment"
  | "container_offload"
  | "savings_transfer"
  | "owner_withdrawal"
  | "sale_economics"
  | "location_sale";

export type GoldenCoastPhase1Preview =
  | { kind: "voucher"; eventType: GoldenCoastPhase1EventType; voucher: Phase1VoucherDraft }
  | { kind: "plan"; eventType: GoldenCoastPhase1EventType; result: unknown };

export interface GoldenCoastLedgerRoleRequirement {
  accountId: number;
  label: string;
  allowedSubTypes: string[];
}

export interface GoldenCoastCashRoleRequirement {
  account: PostingAccount;
  label: string;
}

export class GoldenCoastPhase1InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenCoastPhase1InputError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase1InputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase1InputError(`${label} is required`);
  return text;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new GoldenCoastPhase1InputError(`${label} must be a string`);
  return value.trim() || undefined;
}

function moneyInput(value: unknown, label: string): MoneyInput {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase1InputError(`${label} must be a number or numeric string`);
  }
  return value;
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase1InputError(`${label} must be a positive integer`);
  }
  return id;
}

function postingAccount(value: unknown, label: string): PostingAccount {
  const input = record(value, label);
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase1InputError(`${label}.kind must be "ledger" or "bank"`);
  }
  return {
    kind: input.kind,
    id: positiveId(input.id, `${label}.id`),
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
  };
}

function ledgerAccount(value: unknown, label: string): PostingAccount {
  const account = postingAccount(value, label);
  if (account.kind !== "ledger") {
    throw new GoldenCoastPhase1InputError(`${label} must reference a ledger account`);
  }
  return account;
}

function eventType(input: Record<string, unknown>): GoldenCoastPhase1EventType {
  const value = requiredText(input.type, "event.type") as GoldenCoastPhase1EventType;
  const supported: GoldenCoastPhase1EventType[] = [
    "partner_cash_contribution",
    "inventory_in_transit_contribution",
    "container_reserve_plan",
    "funding_allocation_plan",
    "container_cost_payment",
    "container_offload",
    "savings_transfer",
    "owner_withdrawal",
    "sale_economics",
    "location_sale",
  ];
  if (!supported.includes(value)) {
    throw new GoldenCoastPhase1InputError(`Unsupported Phase 1 event type: ${value}`);
  }
  return value;
}

function wrapBusinessValidation<T>(builder: () => T): T {
  try {
    return builder();
  } catch (error: unknown) {
    if (error instanceof GoldenCoastPhase1InputError) throw error;
    throw new GoldenCoastPhase1InputError(error instanceof Error ? error.message : String(error));
  }
}

function roleRequirement(value: unknown, label: string, allowedSubTypes: string[]): GoldenCoastLedgerRoleRequirement {
  const account = ledgerAccount(value, label);
  return { accountId: account.id, label, allowedSubTypes };
}

function cashRequirement(value: unknown, label: string): GoldenCoastCashRoleRequirement {
  return { account: postingAccount(value, label), label };
}

export function getGoldenCoastPhase1LedgerRoleRequirements(event: unknown): GoldenCoastLedgerRoleRequirement[] {
  const input = record(event, "event");
  const type = eventType(input);
  const capitalSubTypes = ["gc_partner_capital", "gc_owner_capital"];

  switch (type) {
    case "partner_cash_contribution":
      return [roleRequirement(input.partnerCapitalAccount, "event.partnerCapitalAccount", capitalSubTypes)];
    case "inventory_in_transit_contribution":
      return [
        roleRequirement(input.stockOtwAccount, "event.stockOtwAccount", ["sp_goods_otw"]),
        roleRequirement(input.partnerCapitalAccount, "event.partnerCapitalAccount", capitalSubTypes),
      ];
    case "container_cost_payment":
      return [roleRequirement(input.stockOtwAccount, "event.stockOtwAccount", ["sp_goods_otw"])];
    case "container_offload":
      return [
        roleRequirement(input.inventoryAccount, "event.inventoryAccount", ["sp_stock"]),
        roleRequirement(input.stockOtwAccount, "event.stockOtwAccount", ["sp_goods_otw"]),
      ];
    case "owner_withdrawal":
      return [roleRequirement(input.ownerDrawingsAccount, "event.ownerDrawingsAccount", ["gc_owner_drawings"])];
    case "location_sale":
      return [
        roleRequirement(input.salesRevenueAccount, "event.salesRevenueAccount", ["sp_sales"]),
        roleRequirement(input.cogsAccount, "event.cogsAccount", ["sp_cogs"]),
        roleRequirement(input.inventoryAccount, "event.inventoryAccount", ["sp_stock"]),
      ];
    default:
      return [];
  }
}

export function getGoldenCoastPhase1CashRoleRequirements(event: unknown): GoldenCoastCashRoleRequirement[] {
  const input = record(event, "event");
  const type = eventType(input);

  switch (type) {
    case "partner_cash_contribution":
      return [cashRequirement(input.cashAccount, "event.cashAccount")];
    case "container_cost_payment":
      return [cashRequirement(input.paymentAccount, "event.paymentAccount")];
    case "savings_transfer":
      return [
        cashRequirement(input.operatingCashAccount, "event.operatingCashAccount"),
        cashRequirement(input.savingsAccount, "event.savingsAccount"),
      ];
    case "owner_withdrawal":
      return [cashRequirement(input.paymentAccount, "event.paymentAccount")];
    default:
      return [];
  }
}

export function buildGoldenCoastPhase1Preview(event: unknown): GoldenCoastPhase1Preview {
  const input = record(event, "event");
  const type = eventType(input);

  return wrapBusinessValidation(() => {
    switch (type) {
      case "partner_cash_contribution":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildPartnerCashContributionVoucher({
            amountUsd: moneyInput(input.amountUsd, "event.amountUsd"),
            cashAccount: postingAccount(input.cashAccount, "event.cashAccount"),
            partnerCapitalAccount: ledgerAccount(input.partnerCapitalAccount, "event.partnerCapitalAccount"),
            partnerName: requiredText(input.partnerName, "event.partnerName"),
          }),
        };
      case "inventory_in_transit_contribution":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildInventoryInTransitContributionVoucher({
            goodsCostUsd: moneyInput(input.goodsCostUsd, "event.goodsCostUsd"),
            stockOtwAccount: ledgerAccount(input.stockOtwAccount, "event.stockOtwAccount"),
            partnerCapitalAccount: ledgerAccount(input.partnerCapitalAccount, "event.partnerCapitalAccount"),
            partnerName: requiredText(input.partnerName, "event.partnerName"),
            containerReference: optionalText(input.containerReference, "event.containerReference"),
          }),
        };
      case "container_reserve_plan":
        return {
          kind: "plan",
          eventType: type,
          result: buildContainerReservePlan({
            reserveUsd: moneyInput(input.reserveUsd, "event.reserveUsd"),
            expectedDutyUsd: moneyInput(input.expectedDutyUsd, "event.expectedDutyUsd"),
            expectedTransportUsd: moneyInput(input.expectedTransportUsd, "event.expectedTransportUsd"),
          }),
        };
      case "funding_allocation_plan":
        return {
          kind: "plan",
          eventType: type,
          result: buildFundingAllocationPlan({
            fundingBalanceUsd: moneyInput(input.fundingBalanceUsd, "event.fundingBalanceUsd"),
            inventoryInTransitUsd: moneyInput(input.inventoryInTransitUsd, "event.inventoryInTransitUsd"),
            containerReserveUsd: moneyInput(input.containerReserveUsd, "event.containerReserveUsd"),
          }),
        };
      case "container_cost_payment":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildContainerCostPaymentVoucher({
            amountUsd: moneyInput(input.amountUsd, "event.amountUsd"),
            stockOtwAccount: ledgerAccount(input.stockOtwAccount, "event.stockOtwAccount"),
            paymentAccount: postingAccount(input.paymentAccount, "event.paymentAccount"),
            chargeLabel: requiredText(input.chargeLabel, "event.chargeLabel"),
            containerReference: optionalText(input.containerReference, "event.containerReference"),
          }),
        };
      case "container_offload":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildContainerOffloadVoucher({
            totalLandedCostUsd: moneyInput(input.totalLandedCostUsd, "event.totalLandedCostUsd"),
            inventoryAccount: ledgerAccount(input.inventoryAccount, "event.inventoryAccount"),
            stockOtwAccount: ledgerAccount(input.stockOtwAccount, "event.stockOtwAccount"),
            locationId: positiveId(input.locationId, "event.locationId"),
            containerReference: optionalText(input.containerReference, "event.containerReference"),
          }),
        };
      case "savings_transfer":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildSavingsTransferVoucher({
            amountUsd: moneyInput(input.amountUsd, "event.amountUsd"),
            operatingCashAccount: postingAccount(input.operatingCashAccount, "event.operatingCashAccount"),
            savingsAccount: postingAccount(input.savingsAccount, "event.savingsAccount"),
          }),
        };
      case "owner_withdrawal":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildOwnerWithdrawalVoucher({
            amountUsd: moneyInput(input.amountUsd, "event.amountUsd"),
            ownerDrawingsAccount: ledgerAccount(input.ownerDrawingsAccount, "event.ownerDrawingsAccount"),
            paymentAccount: postingAccount(input.paymentAccount, "event.paymentAccount"),
            ownerName: requiredText(input.ownerName, "event.ownerName"),
          }),
        };
      case "sale_economics":
        return {
          kind: "plan",
          eventType: type,
          result: calculateSaleEconomics({
            quantity: moneyInput(input.quantity, "event.quantity"),
            salePricePerUnitUsd: moneyInput(input.salePricePerUnitUsd, "event.salePricePerUnitUsd"),
            inventoryCostPerUnitUsd: moneyInput(input.inventoryCostPerUnitUsd, "event.inventoryCostPerUnitUsd"),
          }),
        };
      case "location_sale":
        return {
          kind: "voucher",
          eventType: type,
          voucher: buildLocationSaleVoucher({
            quantity: moneyInput(input.quantity, "event.quantity"),
            salePricePerUnitUsd: moneyInput(input.salePricePerUnitUsd, "event.salePricePerUnitUsd"),
            inventoryCostPerUnitUsd: moneyInput(input.inventoryCostPerUnitUsd, "event.inventoryCostPerUnitUsd"),
            locationId: positiveId(input.locationId, "event.locationId"),
            cashOrReceivableAccount: postingAccount(input.cashOrReceivableAccount, "event.cashOrReceivableAccount"),
            salesRevenueAccount: ledgerAccount(input.salesRevenueAccount, "event.salesRevenueAccount"),
            cogsAccount: ledgerAccount(input.cogsAccount, "event.cogsAccount"),
            inventoryAccount: ledgerAccount(input.inventoryAccount, "event.inventoryAccount"),
            description: optionalText(input.description, "event.description"),
          }),
        };
    }
  });
}

export function buildGoldenCoastPhase1PostingRequest(input: {
  companyId: number;
  clientRequestId: unknown;
  voucherNumber: unknown;
  voucherDate: unknown;
  event: unknown;
  exchangeRate: string | null;
  actor?: PostingActor;
}): BuiltGenericVoucherPosting & { eventType: GoldenCoastPhase1EventType } {
  const preview = buildGoldenCoastPhase1Preview(input.event);
  if (preview.kind !== "voucher") {
    throw new GoldenCoastPhase1InputError(`${preview.eventType} is a planning event and cannot be posted`);
  }
  if (preview.eventType === "location_sale") {
    throw new GoldenCoastPhase1InputError(
      "location_sale must be posted with buildGoldenCoastPhase1PostingBatch so Sales and COGS remain separate vouchers"
    );
  }

  const built = buildGenericVoucherPostingRequest({
    companyId: input.companyId,
    clientRequestId: input.clientRequestId,
    voucher: {
      locationId: preview.voucher.locationId,
      voucherNumber: requiredText(input.voucherNumber, "voucherNumber"),
      voucherType: preview.voucher.voucherType,
      voucherDate: requiredText(input.voucherDate, "voucherDate"),
      description: preview.voucher.description,
      totalAmount: preview.voucher.totalAmount,
      currency: "USD",
    },
    entries: preview.voucher.entries.map((entry) => ({ ...entry })),
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  built.request.source = {
    sourceType: "golden-coast-phase1",
    sourceId: `${preview.eventType}:${built.clientRequestId}`,
    idempotencyKey: `golden-coast-phase1:${built.clientRequestId}`,
  };

  return { ...built, eventType: preview.eventType };
}
