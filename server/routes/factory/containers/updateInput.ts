// Extracted from ./update.ts: request parsing, validation and FX calculation for a factory container update.
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import { factoryContainers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type Decimal from "decimal.js";
import { toMoney } from "../../../lib/money";
import {
  CONTAINER_MANUAL_FX_INVALID,
  parseContainerManualFxRate,
} from "../../../services/factory/containerManualFxRate";
import type { Request, Response } from "express";

export async function prepareFactoryContainerUpdate({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const id = parseId(req.params.id);
  if (id === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };

  // Keep a mutable copy: the edit dialog submits unchanged goods fields.
  // Those fields must not be mistaken for a new accounting event.
  const b: Record<string, unknown> = { ...(req.body || {}) };

  // Helper: coerce empty-string / undefined to null for numeric/integer columns
  const dec = (v: unknown) => (v === "" || v === undefined || v === null ? null : String(v));
  const int = (v: unknown) => {
    if (v === "" || v === undefined || v === null) return null;
    const n = parseInt(String(v), 10);
    return isNaN(n) ? null : n;
  };
  const str = (v: unknown) => (v === "" || v === undefined || v === null ? null : String(v));

  // Build a strict whitelist — only valid factoryContainers columns
  const updateData: Partial<typeof factoryContainers.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (b.containerNumber !== undefined) updateData.containerNumber = String(b.containerNumber || "");
  if (b.supplierId !== undefined) updateData.supplierId = int(b.supplierId);
  if (b.origin !== undefined) updateData.origin = str(b.origin);
  if (b.totalKg !== undefined) updateData.totalKg = dec(b.totalKg);
  if (b.ratePerKg !== undefined) updateData.ratePerKg = dec(b.ratePerKg);
  if (b.arrivalDate !== undefined) updateData.arrivalDate = str(b.arrivalDate);
  if (b.destination !== undefined) updateData.destination = str(b.destination);
  if (b.notes !== undefined) updateData.notes = str(b.notes);
  if (b.status !== undefined) updateData.status = String(b.status || "PENDING");
  if (b.currencyCode !== undefined) updateData.currencyCode = String(b.currencyCode || "USD");
  if (b.fxRateSource !== undefined) updateData.fxRateSource = String(b.fxRateSource || "auto");
  if (b.fxRateToUsd !== undefined) {
    const fx = dec(b.fxRateToUsd);
    // fx_rate_to_usd is NOT NULL — a blank payload cannot be stored
    if (fx !== null) updateData.fxRateToUsd = fx;
  }
  // Freight
  if (b.freight !== undefined) updateData.freight = dec(b.freight) ?? "0";
  if (b.freightCurrencyCode !== undefined) updateData.freightCurrencyCode = str(b.freightCurrencyCode);
  if (b.freightAccountId !== undefined) updateData.freightAccountId = int(b.freightAccountId);
  if (b.freightSupplierId !== undefined) updateData.freightSupplierId = int(b.freightSupplierId);
  if (b.freightPaidBy !== undefined) updateData.freightPaidBy = String(b.freightPaidBy || "supplier");
  if (b.freightOwnAccountId !== undefined)
    updateData.freightOwnAccountId = b.freightOwnAccountId === null ? null : int(b.freightOwnAccountId);
  // Other charges
  if (b.otherCharges !== undefined) updateData.otherCharges = dec(b.otherCharges) ?? "0";
  if (b.otherChargesCurrencyCode !== undefined) updateData.otherChargesCurrencyCode = str(b.otherChargesCurrencyCode);
  if (b.otherChargesAccountId !== undefined) updateData.otherChargesAccountId = int(b.otherChargesAccountId);
  if (b.otherChargesSupplierId !== undefined) updateData.otherChargesSupplierId = int(b.otherChargesSupplierId);
  // Commission
  if (b.commissionAmount !== undefined) updateData.commissionAmount = dec(b.commissionAmount) ?? "0";
  if (b.commissionCurrencyCode !== undefined) updateData.commissionCurrencyCode = str(b.commissionCurrencyCode);
  if (b.commissionAccountId !== undefined) updateData.commissionAccountId = int(b.commissionAccountId);
  if (b.commissionSupplierId !== undefined) updateData.commissionSupplierId = int(b.commissionSupplierId);
  if (b.commissionNotes !== undefined) updateData.commissionNotes = str(b.commissionNotes);
  // Duty
  if (b.dutyAmount !== undefined) updateData.dutyAmount = dec(b.dutyAmount);
  if (b.dutyAccountId !== undefined) updateData.dutyAccountId = int(b.dutyAccountId);
  if (b.dutyStatus !== undefined) updateData.dutyStatus = String(b.dutyStatus || "NONE");
  if (b.dutyNotes !== undefined) updateData.dutyNotes = str(b.dutyNotes);
  // OTW shared state (visible to all users)
  if (b.otwNote !== undefined) updateData.otwNote = str(b.otwNote);
  if (b.otwDocsReceived !== undefined) updateData.otwDocsReceived = Boolean(b.otwDocsReceived);

  // Always load the existing container — needed for both FX calc and the
  // freight canonicalization below (a partial PATCH may omit freight fields,
  // but we must never clear them based on missing-field defaults).
  const [existing] = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)));
  if (!existing) return { done: true as const, value: res.status(404).json({ message: "Container not found" }) };

  // The edit dialog sends the entire goods section on each Save, including
  // when the user only changed an ETA, note, duty or freight. Preserve
  // historical goods, supplier and FX fields if their values are unchanged.
  // No-op fields must not trigger an import-journal backfill or revaluation.
  const goodsFxModeChanged =
    (b.fxRateSource !== undefined &&
      String(b.fxRateSource || "auto").toLowerCase() !== String(existing.fxRateSource || "auto").toLowerCase()) ||
    (b.currencyCode !== undefined &&
      String(b.currencyCode || "USD").toUpperCase() !== String(existing.currencyCode || "USD").toUpperCase());
  const unchangedGoodsFields = {
    supplierId: updateData.supplierId === existing.supplierId,
    totalKg: toMoney(updateData.totalKg).eq(toMoney(existing.totalKg)),
    ratePerKg: toMoney(updateData.ratePerKg).eq(toMoney(existing.ratePerKg)),
    currencyCode:
      String(updateData.currencyCode || "USD").toUpperCase() === String(existing.currencyCode || "USD").toUpperCase(),
    fxRateSource: String(updateData.fxRateSource || "auto") === String(existing.fxRateSource || "auto"),
    // A switch to manual FX is a genuine action even when the displayed
    // numeric rate matches the old row. Keep the submitted rate so the
    // manual-rate validation can run, instead of treating it as absent.
    fxRateToUsd: !goodsFxModeChanged && toMoney(updateData.fxRateToUsd).eq(toMoney(existing.fxRateToUsd)),
  };
  for (const field of Object.keys(unchangedGoodsFields) as Array<keyof typeof unchangedGoodsFields>) {
    if (b[field] === undefined || unchangedGoodsFields[field]) {
      delete b[field];
      delete updateData[field];
    }
  }

  // Do the same for freight/commission: otherwise a full-form notes edit
  // can create a missing legacy freight or commission journal, or silently
  // reprice an existing one. Only a genuine charge edit should sync it.
  const unchangedChargeFields = {
    freight: toMoney(updateData.freight).eq(toMoney(existing.freight)),
    freightCurrencyCode:
      String(updateData.freightCurrencyCode || "USD").toUpperCase() ===
      String(existing.freightCurrencyCode || "USD").toUpperCase(),
    freightAccountId: updateData.freightAccountId === existing.freightAccountId,
    freightSupplierId: updateData.freightSupplierId === existing.freightSupplierId,
    freightPaidBy: String(updateData.freightPaidBy || "supplier") === String(existing.freightPaidBy || "supplier"),
    freightOwnAccountId: updateData.freightOwnAccountId === existing.freightOwnAccountId,
    commissionAmount: toMoney(updateData.commissionAmount).eq(toMoney(existing.commissionAmount)),
    commissionCurrencyCode:
      String(updateData.commissionCurrencyCode || "USD").toUpperCase() ===
      String(existing.commissionCurrencyCode || "USD").toUpperCase(),
    commissionAccountId: updateData.commissionAccountId === existing.commissionAccountId,
    commissionSupplierId: updateData.commissionSupplierId === existing.commissionSupplierId,
    commissionNotes: updateData.commissionNotes === existing.commissionNotes,
  };
  for (const field of Object.keys(unchangedChargeFields) as Array<keyof typeof unchangedChargeFields>) {
    if (b[field] === undefined || unchangedChargeFields[field]) {
      delete b[field];
      delete updateData[field];
    }
  }

  // Resolve commission FX when commission amount or currency changed.
  // A partial PATCH that touches an unrelated field must preserve existing commission FX.
  const commissionChanged = b.commissionAmount !== undefined || b.commissionCurrencyCode !== undefined;
  if (commissionChanged) {
    const effCommAmt = toMoney(
      updateData.commissionAmount !== undefined ? updateData.commissionAmount : existing.commissionAmount
    );
    const effCommCcy = (
      updateData.commissionCurrencyCode !== undefined
        ? updateData.commissionCurrencyCode || "USD"
        : existing.commissionCurrencyCode || "USD"
    ).toUpperCase();
    const effContainerCcy = (updateData.currencyCode || existing.currencyCode || "USD").toUpperCase();
    const effDate = updateData.arrivalDate || existing.arrivalDate || getClientDate(req);
    if (effCommAmt.greaterThan(0)) {
      let commFxResolved: Decimal;
      if (effCommCcy === "USD") {
        commFxResolved = toMoney(1);
      } else if (effCommCcy === effContainerCcy) {
        // Same currency as container: use the (possibly just-updated) container FX
        const containerFxNum = toMoney(
          updateData.fxRateToUsd !== undefined ? updateData.fxRateToUsd : existing.fxRateToUsd
        );
        if (containerFxNum.lessThanOrEqualTo(0)) {
          return {
            done: true as const,
            value: res.status(400).json({
              message: `Cannot resolve commission FX for ${effCommCcy}: container FX rate is not confirmed.`,
            }),
          };
        }
        commFxResolved = containerFxNum;
      } else {
        // Phase 19 C (M2): the recorded factory rate on or before the date, or 409.
        commFxResolved = toMoney((await factoryDocumentRate(db, companyId, effCommCcy, effDate)).rate);
      }
      updateData.commissionFxRateToUsd = commFxResolved.toFixed();
      updateData.commissionFxRateConfirmed = true;
      updateData.commissionFxRateDate = effDate;
    } else {
      // Commission zeroed out — clear commission FX fields
      updateData.commissionFxRateToUsd = null;
      updateData.commissionFxRateConfirmed = false;
      updateData.commissionFxRateDate = null;
    }
  }

  // FX rate computation (same logic as before)
  const needsFxCalc =
    updateData.currencyCode ||
    updateData.ratePerKg ||
    updateData.fxRateSource ||
    (updateData.fxRateToUsd !== undefined && (updateData.fxRateSource || existing.fxRateSource || "auto") === "manual");
  if (needsFxCalc) {
    const currencyCode = updateData.currencyCode || existing.currencyCode || "USD";
    const fxRateSource = updateData.fxRateSource || existing.fxRateSource || "auto";
    const importDate = updateData.arrivalDate || existing.arrivalDate || getClientDate(req);

    if (fxRateSource === "auto") {
      // Phase 19 C (M2): the recorded factory rate on or before the date (manual,
      // else recorded auto), or 409 FACTORY_FX_RATE_REQUIRED. It used to fetch an
      // external rate, never record it, and mark it confirmed.
      const fxRate = (await factoryDocumentRate(db, companyId, currencyCode, importDate)).rate;
      updateData.fxRateToUsd = fxRate;
      updateData.fxRateToUsdImport = fxRate;
      updateData.fxRateDateImport = importDate;
      updateData.fxRateSource = "auto";
      updateData.fxRateConfirmed = true; // a recorded dated rate
      const ratePerKg = toMoney(updateData.ratePerKg || existing.ratePerKg);
      updateData.ratePerKgUsd = (currencyCode === "USD" ? ratePerKg : ratePerKg.times(toMoney(fxRate))).toFixed();
    } else {
      // Manual: trust an fxRateToUsd explicitly provided in THIS request regardless of
      // value; otherwise fall back to the existing stored rate, but only if it's actually
      // confirmed already (or, absent the flag on this row, looks like a real explicit
      // rate under the legacy heuristic).
      const explicitRate = b.fxRateToUsd !== undefined ? parseContainerManualFxRate(b.fxRateToUsd, currencyCode) : null;
      if (b.fxRateToUsd !== undefined && !explicitRate) {
        return { done: true as const, value: res.status(400).json({ message: CONTAINER_MANUAL_FX_INVALID }) };
      }
      let fxRateNum: Decimal;
      if (explicitRate) {
        // The operator's manual rate is a confirmed rate for this container,
        // not an instruction to create or change a dated company-wide FX rate.
        fxRateNum = explicitRate;
        updateData.fxRateConfirmed = true; // explicitly supplied in this PATCH
      } else {
        const { fxRate, looksSet } = resolveStoredFxRate(currencyCode, existing.fxRateToUsd, existing.fxRateConfirmed);
        if (!looksSet) {
          return {
            done: true as const,
            value: res.status(400).json({ message: new UnresolvedExchangeRateError(currencyCode).message }),
          };
        }
        fxRateNum = toMoney(fxRate);
        // Carries forward an already-confirmed rate; leave fxRateConfirmed untouched.
      }
      const ratePerKg = toMoney(updateData.ratePerKg || existing.ratePerKg);
      updateData.fxRateToUsd = fxRateNum.toFixed();
      updateData.fxRateToUsdImport = fxRateNum.toFixed();
      updateData.fxRateDateImport = importDate;
      updateData.fxRateSource = "manual";
      updateData.ratePerKgUsd = (currencyCode === "USD" ? ratePerKg : ratePerKg.times(fxRateNum)).toFixed();
    }
  }

  return { done: false as const, companyId, id, b, dec, int, updateData, existing };
}
