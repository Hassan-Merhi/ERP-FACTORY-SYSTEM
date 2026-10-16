import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { PostingActor, CentralPostingRequest } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastPhase4CutoverFifo";

export const GOLDEN_COAST_PHASE8_SOURCE_TYPE = "golden-coast-phase8-container";
export const GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE = "golden_coast_phase8_offload";
export const GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER = "fresh-start-excel:fund";
export const GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH = 48;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_SCALE = 2;
const QUANTITY_SCALE = 4;
const UNIT_RATE_SCALE = 4;

export type GoldenCoastPhase8ErrorCode =
  | "GC_PHASE8_INPUT_INVALID"
  | "GC_PHASE8_PRE_CUTOVER_DATE"
  | "GC_PHASE8_RESERVE_EXCEEDED"
  | "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
  | "GC_PHASE8_SCOPE_MISMATCH";

export class GoldenCoastPhase8Error extends Error {
  readonly code: GoldenCoastPhase8ErrorCode;

  constructor(message: string, code: GoldenCoastPhase8ErrorCode = "GC_PHASE8_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase8Error";
    this.code = code;
  }
}

export type GoldenCoastPhase8PostingAccount = { kind: "ledger"; id: number } | { kind: "bank"; id: number };

export interface GoldenCoastPhase8ContainerLineInput {
  stockItemId: number;
  articleCode: string;
  description: string | null;
  qty: string;
  unitRateUsd: string;
}

export interface GoldenCoastPhase8ContainerInput {
  companyId: number;
  clientRequestId: string;
  supplierId: number | null;
  supplierName: string;
  containerNumber: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
  notes: string | null;
}

export interface GoldenCoastPhase8ChargeInput {
  chargeType: "duty" | "transport" | "other";
  description: string | null;
  amountUsd: string;
}

export interface GoldenCoastPhase8OffloadInput {
  companyId: number;
  clientRequestId: string;
  containerId: number;
  locationId: number;
  offloadDate: string;
  charges: GoldenCoastPhase8ChargeInput[];
  /**
   * Where the actual charges are paid from. Phase 8-funded containers already
   * hold a real reserve, so this is unused for them; a container carried
   * through the cutover has no reserve, so its charges need a funding account.
   */
  chargeFundingAccount: GoldenCoastPhase8PostingAccount | null;
}

export interface GoldenCoastPhase8RoleAccounts {
  stockOtwAccountId: number;
  stockInHandAccountId: number;
  containerReserveAccountId: number;
  hassanEquityAccountId: number;
  hassanSavingsAccountId: number;
}

export interface GoldenCoastPhase8FundingPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  totalFundingUsd: string;
  totalQty: string;
  digest: string;
}

/**
 * `phase8` containers were funded by this phase's own endpoint and carry a real
 * container reserve. `cutover` containers were carried across the September 1
 * cutover by the migration, which links a `GC-OTW-*` voucher and never funds a
 * reserve — their charges settle against a funding account at offload instead.
 */
export type GoldenCoastPhase8ContainerOrigin = "phase8" | "cutover" | "fresh_start_excel";

export interface GoldenCoastPhase8FundedContainerState {
  containerId: number;
  companyId: number;
  origin: GoldenCoastPhase8ContainerOrigin;
  fundingVoucherId: number;
  goodsCostUsd: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
}

export interface GoldenCoastPhase8OffloadLinePlan extends GoldenCoastPhase8ContainerLineInput {
  baseUnitCostUsd: string;
  landedUnitCostUsd: string;
  finalUnitCostUsd: string;
}

export interface GoldenCoastPhase8OffloadPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  actualChargesUsd: string;
  unusedReserveUsd: string;
  totalQty: string;
  totalFinalCostUsd: string;
  lines: GoldenCoastPhase8OffloadLinePlan[];
  digest: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase8Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new GoldenCoastPhase8Error(`${label} must be a positive integer`);
  return id;
}

function optionalPositiveId(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  return positiveId(value, label);
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase8Error(`${label} is required`);
  if (text.length > max) throw new GoldenCoastPhase8Error(`${label} must be at most ${max} characters`);
  return text;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase8Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new GoldenCoastPhase8Error(`${label} must be at most ${max} characters`);
  return text;
}

function decimal(value: unknown, label: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase8Error(`${label} must be numeric`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase8Error(`${label} must be numeric`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function isoDate(value: unknown, label: string): string {
  const text = requiredText(value, label, 10);
  if (!ISO_DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new GoldenCoastPhase8Error(`${label} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastPhase8Error(
      `${label} cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_PHASE8_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

function requestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase8Error("clientRequestId contains unsupported characters");
  }
  return text;
}

function postingAccount(value: unknown, label: string): GoldenCoastPhase8PostingAccount {
  const raw = record(value, label);
  if (raw.kind !== "ledger" && raw.kind !== "bank") {
    throw new GoldenCoastPhase8Error(`${label}.kind must be "ledger" or "bank"`);
  }
  return { kind: raw.kind, id: positiveId(raw.id, `${label}.id`) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function accountTarget(account: GoldenCoastPhase8PostingAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

export function parseGoldenCoastPhase8ContainerInput(input: {
  companyId: number;
  body: unknown;
  maxLines?: number;
}): GoldenCoastPhase8ContainerInput {
  const companyId = positiveId(input.companyId, "companyId");
  const raw = record(input.body, "request body");
  const maxLines = input.maxLines ?? 100;
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new GoldenCoastPhase8Error("lines must contain at least one container line");
  }
  if (raw.lines.length > maxLines) throw new GoldenCoastPhase8Error(`lines must contain at most ${maxLines} lines`);

  const seen = new Set<number>();
  const lines = raw.lines.map((value, index): GoldenCoastPhase8ContainerLineInput => {
    const line = record(value, `lines[${index}]`);
    const stockItemId = positiveId(line.stockItemId, `lines[${index}].stockItemId`);
    if (seen.has(stockItemId)) throw new GoldenCoastPhase8Error(`lines[${index}] repeats stock item ${stockItemId}`);
    seen.add(stockItemId);
    const qty = decimal(line.qty, `lines[${index}].qty`);
    const unitRate = decimal(line.unitRateUsd, `lines[${index}].unitRateUsd`);
    if (!qty.gt(0) || qty.decimalPlaces() > QUANTITY_SCALE) {
      throw new GoldenCoastPhase8Error(
        `lines[${index}].qty must be greater than zero with at most ${QUANTITY_SCALE} decimals`
      );
    }
    if (!unitRate.gt(0) || unitRate.decimalPlaces() > UNIT_RATE_SCALE) {
      throw new GoldenCoastPhase8Error(
        `lines[${index}].unitRateUsd must be greater than zero with at most ${UNIT_RATE_SCALE} decimals`
      );
    }
    return {
      stockItemId,
      articleCode: requiredText(line.articleCode, `lines[${index}].articleCode`, 100),
      description: optionalText(line.description, `lines[${index}].description`, 500),
      qty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      unitRateUsd: unitRate.toDecimalPlaces(UNIT_RATE_SCALE).toFixed(UNIT_RATE_SCALE),
    };
  });

  const reserve = decimal(raw.reserveUsd ?? 0, "reserveUsd");
  if (reserve.lt(0) || reserve.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase8Error(`reserveUsd cannot be negative and supports at most ${MONEY_SCALE} decimals`);
  }

  return {
    companyId,
    clientRequestId: requestId(raw.clientRequestId),
    supplierId: optionalPositiveId(raw.supplierId, "supplierId"),
    supplierName: requiredText(raw.supplierName, "supplierName", 200),
    containerNumber: optionalText(raw.containerNumber, "containerNumber", 100),
    invoiceNumber: requiredText(raw.invoiceNumber, "invoiceNumber", 100),
    invoiceDate: isoDate(raw.invoiceDate, "invoiceDate"),
    reserveUsd: money(reserve),
    fundingAccount: postingAccount(raw.fundingAccount, "fundingAccount"),
    lines,
    notes: optionalText(raw.notes, "notes", 1000),
  };
}

export function planGoldenCoastPhase8Funding(container: GoldenCoastPhase8ContainerInput): GoldenCoastPhase8FundingPlan {
  let goods = new Decimal(0);
  let qty = new Decimal(0);
  for (const line of container.lines) {
    goods = goods.plus(new Decimal(line.qty).times(line.unitRateUsd));
    qty = qty.plus(line.qty);
  }
  goods = goods.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  const reserve = new Decimal(container.reserveUsd);
  const total = goods.plus(reserve);
  if (!goods.gt(0)) throw new GoldenCoastPhase8Error("Container goods cost must be greater than zero");
  return {
    goodsCostUsd: money(goods),
    reserveUsd: money(reserve),
    totalFundingUsd: money(total),
    totalQty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    digest: digest({
      companyId: container.companyId,
      supplierId: container.supplierId,
      supplierName: container.supplierName,
      containerNumber: container.containerNumber,
      invoiceNumber: container.invoiceNumber,
      invoiceDate: container.invoiceDate,
      reserveUsd: container.reserveUsd,
      fundingAccount: container.fundingAccount,
      lines: container.lines,
    }),
  };
}

export function buildGoldenCoastPhase8FundingPosting(input: {
  container: GoldenCoastPhase8ContainerInput;
  plan: GoldenCoastPhase8FundingPlan;
  accounts: GoldenCoastPhase8RoleAccounts;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { container, plan, accounts } = input;
  const entries: Array<Record<string, unknown>> = [
    {
      ledgerAccountId: accounts.stockOtwAccountId,
      debitAmount: plan.goodsCostUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container ${container.invoiceNumber} goods in transit`,
    },
  ];
  if (new Decimal(plan.reserveUsd).gt(0)) {
    entries.push({
      ledgerAccountId: accounts.containerReserveAccountId,
      debitAmount: plan.reserveUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container ${container.invoiceNumber} real reserve set aside`,
    });
  }
  entries.push({
    ...accountTarget(container.fundingAccount),
    debitAmount: "0.00",
    creditAmount: plan.totalFundingUsd,
    narration: `Golden Coast container ${container.invoiceNumber} funding`,
  });

  const built = buildGenericVoucherPostingRequest({
    companyId: container.companyId,
    clientRequestId: `gc8-${container.clientRequestId}-fund`,
    voucher: {
      voucherNumber: `GC-C8-${container.companyId}-${container.clientRequestId}-F`,
      voucherType: "Journal",
      voucherDate: container.invoiceDate,
      description: releaseDebtEnglish(`Golden Coast Phase 8 container funding — ${container.invoiceNumber}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${container.clientRequestId}:${plan.digest.slice(0, 20)}:fund`,
      idempotencyKey: `gc8:${container.companyId}:${container.clientRequestId}:fund`,
    },
  };
}


/** Post Fresh Start invoice against GC Goods OTW and its internal clearing
 * account, NOT a supplier payable or Cash/Bank account.
 */
export function buildGoldenCoastFreshStartExcelFundingPosting(input: {
  container: GoldenCoastPhase8ContainerInput;
  invoiceTotalUsd: string;
  otwClearingAccountId: number;
  stockOtwAccountId: number;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { container, invoiceTotalUsd, otwClearingAccountId, stockOtwAccountId } = input;
  const amount = decimal(invoiceTotalUsd, "invoiceTotalUsd");
  if (!amount.gt(0) || amount.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase8Error("invoiceTotalUsd must be positive with at most two decimals");
  }
  const entries = [
    {
      ledgerAccountId: stockOtwAccountId,
      debitAmount: money(amount),
      creditAmount: "0.00",
      narration: `Fresh Start FZE container ${container.invoiceNumber} goods in transit`,
    },
    {
      ledgerAccountId: otwClearingAccountId,
      debitAmount: "0.00",
      creditAmount: money(amount),
      narration: `Fresh Start FZE container ${container.invoiceNumber} Goods OTW Clearing`,
    },
  ];
  const built = buildGenericVoucherPostingRequest({
    companyId: container.companyId,
    clientRequestId: `gc8-${container.clientRequestId}-fund`,
    voucher: {
      voucherNumber: `GC-C8-${container.companyId}-${container.clientRequestId}-F`,
      voucherType: "Journal",
      voucherDate: container.invoiceDate,
      description: releaseDebtEnglish(`Golden Coast Fresh Start container funding — ${container.invoiceNumber}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${container.clientRequestId}:${createHash("sha256").update(JSON.stringify({ container, invoiceTotalUsd })).digest("hex").slice(0, 20)}:${GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER}`,
      idempotencyKey: `gc8:${container.companyId}:${container.clientRequestId}:fund`,
    },
  };
}

export function parseGoldenCoastPhase8OffloadInput(input: {
  companyId: number;
  body: unknown;
  maxCharges?: number;
}): GoldenCoastPhase8OffloadInput {
  const companyId = positiveId(input.companyId, "companyId");
  const raw = record(input.body, "request body");
  const maxCharges = input.maxCharges ?? 50;
  const chargeRows = raw.charges == null ? [] : raw.charges;
  if (!Array.isArray(chargeRows)) throw new GoldenCoastPhase8Error("charges must be an array");
  if (chargeRows.length > maxCharges)
    throw new GoldenCoastPhase8Error(`charges must contain at most ${maxCharges} items`);
  const charges = chargeRows.map((value, index): GoldenCoastPhase8ChargeInput => {
    const charge = record(value, `charges[${index}]`);
    if (charge.chargeType !== "duty" && charge.chargeType !== "transport" && charge.chargeType !== "other") {
      throw new GoldenCoastPhase8Error(`charges[${index}].chargeType must be duty, transport, or other`);
    }
    const amount = decimal(charge.amountUsd, `charges[${index}].amountUsd`);
    if (!amount.gt(0) || amount.decimalPlaces() > MONEY_SCALE) {
      throw new GoldenCoastPhase8Error(
        `charges[${index}].amountUsd must be greater than zero with at most ${MONEY_SCALE} decimals`
      );
    }
    return {
      chargeType: charge.chargeType,
      description: optionalText(charge.description, `charges[${index}].description`, 500),
      amountUsd: money(amount),
    };
  });
  return {
    companyId,
    clientRequestId: requestId(raw.clientRequestId),
    containerId: positiveId(raw.containerId, "containerId"),
    locationId: positiveId(raw.locationId, "locationId"),
    offloadDate: isoDate(raw.offloadDate, "offloadDate"),
    charges,
    chargeFundingAccount:
      raw.chargeFundingAccount == null ? null : postingAccount(raw.chargeFundingAccount, "chargeFundingAccount"),
  };
}

export function planGoldenCoastPhase8Offload(input: {
  offload: GoldenCoastPhase8OffloadInput;
  funded: GoldenCoastPhase8FundedContainerState;
}): GoldenCoastPhase8OffloadPlan {
  const { offload, funded } = input;
  if (offload.companyId !== funded.companyId || offload.containerId !== funded.containerId) {
    throw new GoldenCoastPhase8Error(
      "Offload does not belong to the funded container company",
      "GC_PHASE8_SCOPE_MISMATCH"
    );
  }
  const goods = new Decimal(funded.goodsCostUsd);
  const reserve = new Decimal(funded.reserveUsd);
  const actual = offload.charges.reduce((sum, charge) => sum.plus(charge.amountUsd), new Decimal(0));
  // A cutover container never had a reserve funded for it, so there is no
  // ceiling to exceed and nothing to sweep back: its charges settle straight
  // against the funding account the operator names on the offload.
  if (funded.origin === "cutover" || funded.origin === "fresh_start_excel") {
    if (!reserve.isZero()) {
      throw new GoldenCoastPhase8Error("An unfunded-clearing container cannot carry a cash reserve", "GC_PHASE8_SCOPE_MISMATCH");
    }
    if (actual.gt(0) && !offload.chargeFundingAccount) {
      throw new GoldenCoastPhase8Error(
        "chargeFundingAccount is required to offload a cutover container with charges",
        "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
      );
    }
  } else if (actual.gt(reserve)) {
    throw new GoldenCoastPhase8Error(
      `Actual container charges ${money(actual)} exceed the funded reserve ${money(reserve)}`,
      "GC_PHASE8_RESERVE_EXCEEDED"
    );
  }
  const unused = funded.origin === "cutover" || funded.origin === "fresh_start_excel" ? new Decimal(0) : reserve.minus(actual);
  const totalQty = funded.lines.reduce((sum, line) => sum.plus(line.qty), new Decimal(0));
  if (!totalQty.gt(0)) throw new GoldenCoastPhase8Error("Funded container has no positive quantity");
  const grossLines = funded.lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.qty).times(line.unitRateUsd)), new Decimal(0),
  );
  // Original item rates remain unchanged; net invoice freight, fees and
  // discount already in Goods OTW are allocated as landed cost at offload.
  const invoiceAdjustment = funded.origin === "fresh_start_excel" ? goods.minus(grossLines) : new Decimal(0);
  const landedPerUnit = actual.plus(invoiceAdjustment).div(totalQty);
  const lines = funded.lines.map((line): GoldenCoastPhase8OffloadLinePlan => {
    const base = new Decimal(line.unitRateUsd);
    const final = base.plus(landedPerUnit);
    return {
      ...line,
      // `landedUnitCostUsd` carries the per-unit charge allocation on its own,
      // matching what the pre-Golden-Coast offload route writes to the same
      // `sp_stock_movements` column; `finalUnitCostUsd` is base + allocation.
      baseUnitCostUsd: base.toDecimalPlaces(6).toFixed(6),
      landedUnitCostUsd: landedPerUnit.toDecimalPlaces(6).toFixed(6),
      finalUnitCostUsd: final.toDecimalPlaces(6).toFixed(6),
    };
  });
  return {
    goodsCostUsd: money(goods),
    reserveUsd: money(reserve),
    actualChargesUsd: money(actual),
    unusedReserveUsd: money(unused),
    totalQty: totalQty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    totalFinalCostUsd: money(goods.plus(actual)),
    lines,
    digest: digest({
      companyId: offload.companyId,
      containerId: offload.containerId,
      locationId: offload.locationId,
      offloadDate: offload.offloadDate,
      charges: offload.charges,
      chargeFundingAccount: offload.chargeFundingAccount,
      origin: funded.origin,
      fundingVoucherId: funded.fundingVoucherId,
      goodsCostUsd: funded.goodsCostUsd,
      reserveUsd: funded.reserveUsd,
      fundingAccount: funded.fundingAccount,
    }),
  };
}

export function buildGoldenCoastPhase8OffloadPosting(input: {
  offload: GoldenCoastPhase8OffloadInput;
  funded: GoldenCoastPhase8FundedContainerState;
  plan: GoldenCoastPhase8OffloadPlan;
  accounts: GoldenCoastPhase8RoleAccounts;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { offload, funded, plan, accounts } = input;
  const entries: Array<Record<string, unknown>> = [
    {
      ledgerAccountId: accounts.stockInHandAccountId,
      debitAmount: plan.totalFinalCostUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container #${offload.containerId} stock received`,
    },
    {
      ledgerAccountId: accounts.stockOtwAccountId,
      debitAmount: "0.00",
      creditAmount: plan.goodsCostUsd,
      narration: `Golden Coast container #${offload.containerId} clears Stock OTW`,
    },
  ];
  const reserve = new Decimal(plan.reserveUsd);
  const unused = new Decimal(plan.unusedReserveUsd);
  // A cutover container has no reserve to clear and no unused remainder to
  // sweep. Its actual charges are paid at offload, so they credit the funding
  // account the operator named instead of a pre-funded reserve.
  if (funded.origin === "cutover" || funded.origin === "fresh_start_excel") {
    const actual = new Decimal(plan.actualChargesUsd);
    if (actual.gt(0)) {
      if (!offload.chargeFundingAccount) {
        throw new GoldenCoastPhase8Error(
          "chargeFundingAccount is required to offload a cutover container with charges",
          "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
        );
      }
      entries.push({
        ...accountTarget(offload.chargeFundingAccount),
        debitAmount: "0.00",
        creditAmount: plan.actualChargesUsd,
        narration: `Golden Coast container #${offload.containerId} cutover charges paid at offload`,
      });
    }
  } else {
    if (reserve.gt(0)) {
      entries.push({
        ledgerAccountId: accounts.containerReserveAccountId,
        debitAmount: "0.00",
        creditAmount: plan.reserveUsd,
        narration: `Golden Coast container #${offload.containerId} clears funded reserve`,
      });
    }
    if (unused.gt(0)) {
      entries.push(
        {
          ...accountTarget(funded.fundingAccount),
          debitAmount: plan.unusedReserveUsd,
          creditAmount: "0.00",
          narration: `Golden Coast container #${offload.containerId} unused reserve returned to funding account`,
        },
        {
          ledgerAccountId: accounts.hassanEquityAccountId,
          debitAmount: plan.unusedReserveUsd,
          creditAmount: "0.00",
          narration: `Golden Coast container #${offload.containerId} unused reserve reclassified from Hassan equity`,
        },
        {
          ledgerAccountId: accounts.hassanSavingsAccountId,
          debitAmount: "0.00",
          creditAmount: plan.unusedReserveUsd,
          narration: `Golden Coast container #${offload.containerId} unused reserve moved to Hassan Savings`,
        }
      );
    }
  }

  const built = buildGenericVoucherPostingRequest({
    companyId: offload.companyId,
    clientRequestId: `gc8-${offload.clientRequestId}-offload`,
    voucher: {
      voucherNumber: `GC-C8-${offload.companyId}-${offload.clientRequestId}-O`,
      voucherType: "Journal",
      voucherDate: offload.offloadDate,
      locationId: offload.locationId,
      description: releaseDebtEnglish(`Golden Coast Phase 8 container offload #${offload.containerId}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${offload.containerId}:${offload.clientRequestId}:${plan.digest.slice(0, 20)}:offload`,
      idempotencyKey: `gc8:${offload.companyId}:${offload.clientRequestId}:offload`,
    },
  };
}
