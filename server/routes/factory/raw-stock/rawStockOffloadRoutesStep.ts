// Extracted from ./rawStockOffloadRoutes.ts: a stage of rawStockOffloadRoutes.
import Decimal from "decimal.js";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import {
  CONTAINER_MANUAL_FX_INVALID,
  parseContainerManualFxRate,
} from "../../../services/factory/containerManualFxRate";
import { factoryContainers, factoryRawStock, factoryContainerCommissions, factorySuppliers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { computeOffloadCosting } from "./offloadCosting";
import { parseMoneyInput } from "../../../lib/money";
import { allLedgerAccountsOwned } from "../../helpers/companyOwnership";
import { requestNumber } from "./rawStockOffloadRoutesHelpers";
import type { Request, Response } from "express";

export async function rawStockOffloadRoutesStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const {
    containerId,
    receivedKg,
    costPerKg,
    commission,
    currencyCode: reqCurrencyCode,
    fxRateToUsd: reqFxRate,
    freight: reqFreight,
    freightAccountId: reqFreightAccountId,
    freightSupplierId: reqFreightSupplierId,
    freightCurrencyCode: reqFreightCurrencyCode,
    freightFxRate: reqFreightFxRate,
    otherCharges: reqOtherCharges,
    otherChargesAccountId: reqOtherChargesAccountId,
    otherChargesSupplierId: reqOtherChargesSupplierId,
    otherChargesCurrencyCode: reqOtherChargesCurrencyCode,
    otherChargesFxRate: reqOtherChargesFxRate,
    dutyAmount: reqDutyAmount,
    dutyAccountId: reqDutyAccountId,
    dutyStatus: reqDutyStatus,
    dutyNotes: reqDutyNotes,
    additionalCharges: reqAdditionalCharges,
    offloadDate: reqOffloadDate,
    mixBatchAllocations: reqMixBatchAllocations,
    destination: reqDestination,
    idempotencyKey,
  } = req.body;
  if (!containerId)
    return { done: true as const, value: res.status(400).json({ message: "Container ID is required" }) };
  // Charge and commission accounts are body ids the path-based company scope never sees.
  const chargeAccountIds = [
    reqFreightAccountId,
    reqOtherChargesAccountId,
    reqDutyAccountId,
    commission?.ledgerAccountId,
    ...(Array.isArray(reqAdditionalCharges) ? reqAdditionalCharges : []).map(
      (charge: { ledgerAccountId?: unknown }) => charge?.ledgerAccountId
    ),
  ];
  if (!(await allLedgerAccountsOwned(companyId, chargeAccountIds))) {
    return { done: true as const, value: res.status(400).json({ message: "Account not found" }) };
  }

  // Validate receivedKg upfront — required for both first and subsequent receipts.
  // An explicit positive finite value is mandatory; the old `receivedKg || declaredKg`
  // fallback silently accepted a missing receivedKg and treated it as a full offload.
  const receivedKgInput = parseMoneyInput(receivedKg);
  if (!receivedKg || !receivedKgInput || receivedKgInput.lessThanOrEqualTo(0)) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "receivedKg must be a positive finite number" }),
    };
  }

  const [container] = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

  if (!container) return { done: true as const, value: res.status(404).json({ message: "Container not found" }) };

  const [materialSupplier] = container.supplierId
    ? await db
        .select({ name: factorySuppliers.name })
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, container.supplierId), eq(factorySuppliers.companyId, companyId)))
    : [];
  const supplierNarrationSuffix = materialSupplier?.name?.trim() ? ` - ${materialSupplier.name.trim()}` : "";

  const [existingRawStock] = await db
    .select()
    .from(factoryRawStock)
    .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

  // A PARTIALLY_RECEIVED container may receive additional kg (subsequent receipt).
  // A fully OFFLOADED container (cumulative received >= declared) must not.
  const isSubsequentReceipt = !!existingRawStock;
  if (isSubsequentReceipt && container.status === "OFFLOADED") {
    return {
      done: true as const,
      value: res.status(400).json({ message: "This container has already been fully offloaded" }),
    };
  }

  const currencyCode = reqCurrencyCode || container.currencyCode || "USD";
  const today = getClientDate(req);
  const offloadDate = reqOffloadDate || today;
  const mixBatchAllocationsArr = Array.isArray(reqMixBatchAllocations) ? reqMixBatchAllocations : [];

  // Offloading a container with a confirmed operator-entered manual goods rate
  // must not require a separate company-wide dated FX row. Restrict this
  // exception to that exact container and currency; other factory documents
  // and auto-rate containers still follow the dated-rate accounting rule.
  const ownsConfirmedManualFx =
    container.fxRateSource === "manual" &&
    container.fxRateConfirmed === true &&
    currencyCode.toUpperCase() === (container.currencyCode || "USD").toUpperCase();
  let fxRate: number;
  let fxRateText: string;
  if (ownsConfirmedManualFx) {
    const manualRate = parseContainerManualFxRate(reqFxRate ?? container.fxRateToUsd, currencyCode);
    if (!manualRate)
      return { done: true as const, value: res.status(400).json({ message: CONTAINER_MANUAL_FX_INVALID }) };
    fxRateText = manualRate.toFixed();
    fxRate = manualRate.toNumber();
  } else {
    try {
      const ownRate =
        reqFxRate && requestNumber(reqFxRate) > 0 ? { rate: String(reqFxRate), confirmed: true } : undefined;
      fxRateText = (await factoryDocumentRate(db, companyId, currencyCode, offloadDate, ownRate)).rate;
      fxRate = requestNumber(fxRateText);
    } catch (rateError) {
      if (rateError instanceof FactoryFxRateRequiredError)
        return { done: true as const, value: res.status(409).json(rateError.body) };
      throw rateError;
    }
  }

  const declaredKg = container.totalKg || "0";
  const dReceivedKg = new Decimal(receivedKg);
  const baseCostPerKg = costPerKg || container.ratePerKg || "0";
  const differenceKg = new Decimal(declaredKg).minus(dReceivedKg).toDecimalPlaces(3).toFixed(3);

  // Fall back to the container's own supplier for freight payee when the offload
  // request didn't explicitly resend one. Container creation and the PATCH freight-sync
  // route both credit container.supplierId whenever freightPaidBy='supplier' (the
  // default) without requiring a separate freightSupplierId to be selected again — the
  // offload form should honor the same default, or freight silently falls into the
  // no-payee ledger branch (Dr Factory Charges Payable / Cr Freight), which nets the
  // freight expense to zero and leaves an unresolved balance in Charges Payable.
  // Resolve who receives the freight credit.
  // Only auto-assign a supplier if the container has a dedicated freight
  // supplier (freightSupplierId) — NEVER fall back to the material supplier
  // (container.supplierId), because freight may be paid via an own account
  // (e.g. Embassy Shipping) that has nothing to do with the material supplier.
  const effectiveFreightSupplierId: number | null = reqFreightSupplierId
    ? parseInt(reqFreightSupplierId)
    : !reqFreightAccountId && container.freightSupplierId
      ? container.freightSupplierId
      : null;

  const freightVal = requestNumber(reqFreight || "0");
  const otherChargesVal = requestNumber(reqOtherCharges || "0");
  const additionalChargesArr = Array.isArray(reqAdditionalCharges) ? reqAdditionalCharges : [];
  const dutyVal = reqDutyStatus === "CONFIRMED" ? requestNumber(reqDutyAmount || "0") : 0;
  const dutyStatus = reqDutyStatus || "NONE";
  // Every positive offload charge must have a real double-entry
  // counterparty. Never save costs/daybook only while silently omitting the
  // ledger journal. For duties the chosen account is the credit account.
  if (!isSubsequentReceipt && freightVal > 0 && !reqFreightAccountId && !effectiveFreightSupplierId) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: "Select the freight supplier or paying account before offloading.",
      }),
    };
  }
  if (!isSubsequentReceipt && otherChargesVal > 0 && !reqOtherChargesAccountId && !reqOtherChargesSupplierId) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: "Select the other-charges supplier or paying account before offloading.",
      }),
    };
  }
  if (!isSubsequentReceipt && dutyVal > 0 && !reqDutyAccountId) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: "Select the duty payment account before confirming duties and offloading.",
      }),
    };
  }
  for (const extra of isSubsequentReceipt ? [] : additionalChargesArr) {
    const amount = parseMoneyInput(extra?.amount);
    if (amount?.greaterThan(0) && Number(Boolean(extra.ledgerAccountId)) + Number(Boolean(extra.supplierId)) !== 1) {
      return {
        done: true as const,
        value: res.status(400).json({
          message: "Each positive additional charge needs exactly one paying account or supplier.",
        }),
      };
    }
  }

  // ── Commission computation (DB insert deferred into the transaction) ──────
  // Assigned by the offload transaction once the commission row is inserted.
  const commissionRecord = null as typeof factoryContainerCommissions.$inferSelect | null;
  const costing = await computeOffloadCosting({
    companyId,
    containerId,
    container,
    currencyCode,
    fxRate,
    offloadDate,
    declaredKg,
    dReceivedKg,
    baseCostPerKg,
    commission,
    freightVal,
    otherChargesVal,
    additionalChargesArr,
    dutyVal,
    dutyStatus,
    effectiveFreightSupplierId,
    reqFreightCurrencyCode,
    reqFreightFxRate,
    reqFreightAccountId,
    reqOtherChargesCurrencyCode,
    reqOtherChargesFxRate,
    reqOtherChargesSupplierId,
    reqOtherChargesAccountId,
  });
  if (!costing.ok) return { done: true as const, value: res.status(costing.httpStatus).json(costing.body) };
  const {
    commTotalVal,
    commCurrencyForUsd,
    commFxRateForUsd,
    commInsertValues,
    freightCcy,
    freightFxRateVal,
    ocCcy,
    ocFxRateVal,
    dInclusiveCostPerKg,
    dCostPerKgUsd,
    finalPayableAmount,
    finalPayableAmountUsd,
    newStatus,
    chargesPayableAcctId,
    freightExpenseAcctId,
    ocExpenseAcctId,
  } = costing;

  return {
    done: false as const,
    companyId,
    containerId,
    receivedKg,
    reqFreight,
    reqFreightAccountId,
    reqFreightCurrencyCode,
    reqFreightFxRate,
    reqOtherCharges,
    reqOtherChargesAccountId,
    reqOtherChargesSupplierId,
    reqOtherChargesCurrencyCode,
    reqOtherChargesFxRate,
    reqDutyAmount,
    reqDutyAccountId,
    reqDutyNotes,
    reqDestination,
    idempotencyKey,
    container,
    materialSupplier,
    supplierNarrationSuffix,
    isSubsequentReceipt,
    currencyCode,
    offloadDate,
    mixBatchAllocationsArr,
    fxRate,
    fxRateText,
    declaredKg,
    dReceivedKg,
    differenceKg,
    effectiveFreightSupplierId,
    freightVal,
    otherChargesVal,
    additionalChargesArr,
    dutyVal,
    dutyStatus,
    commissionRecord,
    commTotalVal,
    commCurrencyForUsd,
    commFxRateForUsd,
    commInsertValues,
    freightCcy,
    freightFxRateVal,
    ocCcy,
    ocFxRateVal,
    dInclusiveCostPerKg,
    dCostPerKgUsd,
    finalPayableAmount,
    finalPayableAmountUsd,
    newStatus,
    chargesPayableAcctId,
    freightExpenseAcctId,
    ocExpenseAcctId,
  };
}
