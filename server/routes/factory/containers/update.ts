/**
 * factoryContainersRoutes: FactoryContainerUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  resolveStoredFxRate,
  resolveStoredFxRateOrThrow,
  UnresolvedExchangeRateError,
} from "../../../services/factory/currencyConversion";
import { getOrCreateLedgerAccount } from "../_helpers";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import { factorySuppliers, factoryContainers, voucherEntries, factoryDaybookEntries, vouchers } from "@shared/schema";
import { eq, and, or, ilike, isNull } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";
import { postFactoryVoucherTx, type FactoryVoucherLine } from "../../../services/factory/factoryVoucherPosting";
import {
  sendVoucherCorrectionRefusal,
  editPostedFactoryVoucherTx,
} from "../../../services/factory/factoryVoucherCorrection";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { containerFreightFxRateToUsd } from "../../../services/factory/factoryVoucherEntryAmounts";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import type Decimal from "decimal.js";
import { parseMoneyInput, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

export function registerFactoryContainerUpdateRoutes(app: Express) {
  app.patch("/api/factory/containers/:id", requireAuth, async (req: Request, res: Response) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.factoryCompanyId || req.session.currentCompanyId;
    try {
      logger.info("factory container update started", {
        module: "factoryContainers",
        action: "update",
        userId: _uid,
        companyId: _cid,
      });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

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
      if (b.otherChargesCurrencyCode !== undefined)
        updateData.otherChargesCurrencyCode = str(b.otherChargesCurrencyCode);
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
      if (!existing) return res.status(404).json({ message: "Container not found" });

      // The edit dialog sends the entire goods section on each Save, including
      // when the user only changed an ETA, note, duty or freight. Preserve
      // historical goods, supplier and FX fields if their values are unchanged.
      // No-op fields must not trigger an import-journal backfill or revaluation.
      const unchangedGoodsFields = {
        supplierId: updateData.supplierId === existing.supplierId,
        totalKg: toMoney(updateData.totalKg).eq(toMoney(existing.totalKg)),
        ratePerKg: toMoney(updateData.ratePerKg).eq(toMoney(existing.ratePerKg)),
        currencyCode:
          String(updateData.currencyCode || "USD").toUpperCase() ===
          String(existing.currencyCode || "USD").toUpperCase(),
        fxRateSource:
          String(updateData.fxRateSource || "auto") === String(existing.fxRateSource || "auto"),
        fxRateToUsd: toMoney(updateData.fxRateToUsd).eq(toMoney(existing.fxRateToUsd)),
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
        freightPaidBy:
          String(updateData.freightPaidBy || "supplier") === String(existing.freightPaidBy || "supplier"),
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
              return res.status(400).json({
                message: `Cannot resolve commission FX for ${effCommCcy}: container FX rate is not confirmed.`,
              });
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
      const needsFxCalc = updateData.currencyCode || updateData.ratePerKg || updateData.fxRateSource;
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
          const explicitRate = b.fxRateToUsd !== undefined ? parseMoneyInput(dec(b.fxRateToUsd) ?? "") : null;
          let fxRateNum: Decimal;
          if (explicitRate && explicitRate.greaterThan(0)) {
            // A manual rate is accepted only where a recorded dated rate exists (the factory document rule).
            await factoryDocumentRate(db, companyId, currencyCode, importDate);
            fxRateNum = explicitRate;
            updateData.fxRateConfirmed = true; // freshly supplied by this request
          } else {
            const { fxRate, looksSet } = resolveStoredFxRate(
              currencyCode,
              existing.fxRateToUsd,
              existing.fxRateConfirmed
            );
            if (!looksSet) {
              return res.status(400).json({ message: new UnresolvedExchangeRateError(currencyCode).message });
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

      // Resolve freight effective values — a partial PATCH may omit any freight
      // field, so we must fall back to the existing stored value rather than
      // treating an absent field as "zero" or "supplier".
      const effectiveFreight = updateData.freight !== undefined ? updateData.freight : existing.freight;
      const effectiveFreightPaidBy: string =
        typeof updateData.freightPaidBy === "string" ? updateData.freightPaidBy : existing.freightPaidBy || "supplier";
      const effectiveFreightOwnAccountId =
        updateData.freightOwnAccountId !== undefined ? updateData.freightOwnAccountId : existing.freightOwnAccountId;
      const effectiveFreightSupplierId =
        updateData.freightSupplierId !== undefined ? updateData.freightSupplierId : existing.freightSupplierId;

      // Auto-create freight ledger account if effective freight > 0 and no account selected
      if (!updateData.freightAccountId && toMoney(effectiveFreight).greaterThan(0)) {
        updateData.freightAccountId = await getOrCreateLedgerAccount(companyId, "FREIGHT", "Freight");
      }

      // Canonicalize freight payer fields so switching "own" ↔ "supplier" never
      // leaves a stale value in the opposing field.  Rules are enforced using
      // the EFFECTIVE values (not just what was sent in this request).
      {
        if (toMoney(effectiveFreight).lessThanOrEqualTo(0)) {
          // Rule A: no freight → clear both payer fields
          updateData.freightSupplierId = null;
          updateData.freightOwnAccountId = null;
        } else if (effectiveFreightPaidBy === "own") {
          // Rule B: own-account freight → require freightOwnAccountId, clear supplier link
          const ownAcctId =
            updateData.freightOwnAccountId !== undefined
              ? updateData.freightOwnAccountId
              : effectiveFreightOwnAccountId;
          if (!ownAcctId) {
            return res.status(400).json({
              message: "freightOwnAccountId is required when freightPaidBy is 'own'",
            });
          }
          updateData.freightSupplierId = null;
        } else {
          // Freight is owed to its own chosen payee, never to the goods supplier by fallback.
          if (!effectiveFreightSupplierId) {
            return res.status(400).json({
              message: "Select the freight supplier before saving supplier-paid freight.",
            });
          }
          const [freightPayee] = await db
            .select({ id: factorySuppliers.id })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, effectiveFreightSupplierId), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          if (!freightPayee) {
            return res.status(400).json({ message: "The selected freight supplier must belong to this company." });
          }
          updateData.freightOwnAccountId = null;
          updateData.freightSupplierId = effectiveFreightSupplierId;
        }
      }

      // ── Sync freight voucher ───────────────────────────────────────────────
      // Guard: only re-run FX-dependent freight entry computation when a
      // freight-relevant field was actually included in this request body.
      // A date-only PATCH (e.g. CSV ETA import sending only { arrivalDate })
      // must NOT trigger resolveStoredFxRateOrThrow — doing so causes a 400
      // for EUR/AUD containers that have freight but no confirmed FX rate,
      // because the import only changes the ETA, not anything freight-related.
      const freightNeedsSync = [
        "freight",
        "freightCurrencyCode",
        "freightAccountId",
        "freightSupplierId",
        "freightPaidBy",
        "freightOwnAccountId",
        "supplierId",
        "currencyCode",
        "ratePerKg",
        "fxRateToUsd",
        "fxRateSource",
      ].some((f) => f in b);

      // A container's goods payable MUST follow changes to the supplier, goods value,
      // currency and historical rate. Previously only the descriptive daybook row
      // followed those edits, which left the supplier's actual ledger incorrect.
      let goodsNeedsSync = ["supplierId", "totalKg", "ratePerKg", "currencyCode", "fxRateToUsd", "fxRateSource"].some(
        (f) => f in b
      );

      // The original goods credit on the 18 reviewed legacy containers was
      // subsequently corrected by a separate, balanced EUR reclassification.
      // Editing the original goods journal again would leave that correction in
      // place and double-count the supplier transfer. A future change must first
      // use a reviewed, compensating-voucher workflow, not a silent in-place edit.
      if (goodsNeedsSync) {
        const [reviewedReclassification] = await db
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.voucherNumber, `FACTORY-PAYABLE-RECLASS-20261015-${id}`),
              isNull(vouchers.deletedAt)
            )
          )
          .limit(1);
        // After the owner's audited compensating journal is posted, the
        // original supplier credit is authoritative again. Only keep this
        // special lock while the Oct-15 reclassification is uncompensated.
        const [undoJournal] = reviewedReclassification
          ? await db
              .select({ id: vouchers.id })
              .from(vouchers)
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  eq(vouchers.voucherNumber, `FACTORY-PAYABLE-RECLASS-REV-20261015-${id}`),
                  isNull(vouchers.deletedAt)
                )
              )
              .limit(1)
          : [];
        if (reviewedReclassification && !undoJournal) {
          const goodsActuallyChanged =
            (b.supplierId !== undefined && int(b.supplierId) !== existing.supplierId) ||
            (b.totalKg !== undefined && !toMoney(dec(b.totalKg)).eq(toMoney(existing.totalKg))) ||
            (b.ratePerKg !== undefined && !toMoney(dec(b.ratePerKg)).eq(toMoney(existing.ratePerKg))) ||
            (b.currencyCode !== undefined &&
              String(b.currencyCode || "USD").toUpperCase() !== String(existing.currencyCode || "USD").toUpperCase()) ||
            (b.fxRateToUsd !== undefined && !toMoney(dec(b.fxRateToUsd)).eq(toMoney(existing.fxRateToUsd))) ||
            (b.fxRateSource !== undefined &&
              String(b.fxRateSource || "auto") !== String(existing.fxRateSource || "auto"));
          if (goodsActuallyChanged) {
            return res.status(409).json({
              code: "FACTORY_IMPORT_RECLASS_REVIEW_REQUIRED",
              message: "FPR_LOCKED",
              correctionVoucherId: reviewedReclassification.id,
            });
          }
          // Many edit dialogs submit unchanged goods fields with unrelated
          // updates. Permit those edits without resynchronizing (and thereby
          // corrupting) the original imported-goods payable or stored FX.
          goodsNeedsSync = false;
          delete updateData.supplierId;
          delete updateData.totalKg;
          delete updateData.ratePerKg;
          delete updateData.currencyCode;
          delete updateData.fxRateToUsd;
          delete updateData.fxRateSource;
          delete updateData.fxRateToUsdImport;
          delete updateData.fxRateDateImport;
          delete updateData.fxRateConfirmed;
          delete updateData.ratePerKgUsd;
        }
      }
      const existingImports = goodsNeedsSync
        ? await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${id}-%`)
              )
            )
            .limit(2)
        : [];
      if (goodsNeedsSync && existingImports.length > 1) {
        return res.status(409).json({
          code: "FACTORY_IMPORT_DUPLICATE_JOURNALS",
          message:
            "Multiple live import journals exist for this container. Reconcile them before changing supplier or goods value.",
        });
      }

      // Find any existing freight voucher for this container (stable or timestamped number)
      const existingFreightVouchers = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            or(
              eq(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}`),
              ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}-%`)
            )
          )
        )
        .limit(2);
      // Never edit only the first of multiple live freight journals. That would
      // leave the other journal posting the same amount, or the wrong payable.
      if (freightNeedsSync && existingFreightVouchers.length > 1) {
        return res.status(409).json({
          code: "FACTORY_FREIGHT_DUPLICATE_JOURNALS",
          message:
            "Multiple live freight journals exist for this container. Reconcile them before changing freight or its supplier.",
        });
      }
      const existingFV = existingFreightVouchers[0];

      // Wave 8.4 continuation: the commission journal FACTORY-COMM-{container}
      // follows every change to the commission or what it is posted at.
      const commissionNeedsSync = [
        "commissionAmount",
        "commissionCurrencyCode",
        "commissionAccountId",
        "commissionSupplierId",
        "supplierId",
        "currencyCode",
        "fxRateToUsd",
        "fxRateSource",
        "ratePerKg",
        "arrivalDate",
      ].some((f) => f in b);

      // The container row, its freight voucher and its commission journal are
      // written in one transaction.
      const updated = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(factoryContainers)
          .set(updateData)
          .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)))
          .returning();
        if (!updated) return null;

        if (goodsNeedsSync) {
          const goodsValue = toMoney(updated.totalKg).times(toMoney(updated.ratePerKg));
          if (goodsValue.lessThanOrEqualTo(0) || !updated.supplierId) {
            if (existingImports.length > 0) {
              throw new Error(
                "A posted goods-import journal cannot lose its purchase supplier or goods amount. Use an audited reversal."
              );
            }
          } else {
            const goodsCcy = updated.currencyCode || "USD";
            const goodsFx = resolveStoredFxRateOrThrow(goodsCcy, updated.fxRateToUsd, updated.fxRateConfirmed);
            const importVoucher = existingImports[0];
            if (importVoucher) {
              const importEntries = await tx
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, importVoucher.id));
              const debitLines = importEntries.filter((line) => toMoney(line.debitAmount).greaterThan(0));
              const creditLines = importEntries.filter((line) => toMoney(line.creditAmount).greaterThan(0));
              if (
                importEntries.length !== 2 ||
                debitLines.length !== 1 ||
                creditLines.length !== 1 ||
                !debitLines[0].ledgerAccountId ||
                !creditLines[0].factorySupplierId
              ) {
                throw new Error("Import journal has an unexpected entry shape. Review its postings before editing.");
              }
              // A non-USD legacy voucher lacks the historical native/base record.
              // Do not rewrite such history with today's or the container's
              // currently displayed rate; it requires the reviewed FX repair.
              if (
                goodsCcy !== "USD" &&
                importEntries.some(
                  (line) => !line.transactionCurrency || line.baseDebitAmount == null || line.baseCreditAmount == null
                )
              ) {
                throw new Error(
                  "This import journal has unconverted historical FX entries. Review and repair its original rate before changing the goods posting."
                );
              }
              const normalizedDr = normFactoryEntry(goodsCcy, goodsValue.toFixed(), "0", goodsFx);
              const normalizedCr = normFactoryEntry(goodsCcy, "0", goodsValue.toFixed(), goodsFx);
              await editPostedFactoryVoucherTx(
                tx,
                {
                  companyId,
                  voucherIds: [importVoucher.id],
                  reason: "factory-container-goods-resync",
                  actor: { userId: req.session.userId, username: req.session.username },
                },
                async () => {
                  await tx
                    .update(vouchers)
                    .set({
                      totalAmount: goodsValue.toFixed(2),
                      currency: goodsCcy,
                      exchangeRate: String(goodsFx),
                    })
                    .where(eq(vouchers.id, importVoucher.id));
                  await tx.update(voucherEntries).set(normalizedDr).where(eq(voucherEntries.id, debitLines[0].id));
                  await tx
                    .update(voucherEntries)
                    .set({
                      ...normalizedCr,
                      // The import (goods) payable belongs to the goods supplier;
                      // only the freight journal credits the freight payee.
                      factorySupplierId: updated.supplierId,
                      ledgerAccountId: null,
                    })
                    .where(eq(voucherEntries.id, creditLines[0].id));
                }
              );
            } else {
              // Historical documents must not acquire a new liability merely
              // because a user edits a container. Require the audited,
              // explicitly-selected backfill workflow instead.
              throw new Error(
                "This container has no goods-import journal. Review it in the import-credit backfill preview and post the missing journal explicitly before editing its goods or supplier."
              );
            }
          }
        }

        const newFreightAmt = toMoney(updated.freight);
        const newFreightAcctId = updated.freightAccountId ?? null;
        const newFreightPaidBy = updated.freightPaidBy || "supplier";
        const newFreightOwnAcctId = updated.freightOwnAccountId ?? null;
        const freightCcy = updated.freightCurrencyCode || updated.currencyCode || "USD";

        if (newFreightAmt.greaterThan(0) && newFreightAcctId) {
          if (existingFV) {
            const editActor = { userId: req.session.userId, username: req.session.username };
            if (freightNeedsSync) {
              // Full re-sync: update voucher amount/type and re-compute entries with FX.
              // Phase 22 (C), G4: an in-place edit of a posted voucher — refused in a
              // closed period (409, correct by reversal), audited before/after otherwise.
              const updateFreightFactoryFxRate = containerFreightFxRateToUsd(updated);
              const normFreightDr = normFactoryEntry(
                freightCcy,
                newFreightAmt.toFixed(),
                "0",
                updateFreightFactoryFxRate
              );
              const normFreightCr = normFactoryEntry(
                freightCcy,
                "0",
                newFreightAmt.toFixed(),
                updateFreightFactoryFxRate
              );
              await editPostedFactoryVoucherTx(
                tx,
                {
                  companyId,
                  voucherIds: [existingFV.id],
                  reason: "factory-container-freight-resync",
                  actor: editActor,
                },
                async () => {
                  await tx
                    .update(vouchers)
                    .set({
                      totalAmount: newFreightAmt.toFixed(),
                      currency: freightCcy,
                      exchangeRate: String(updateFreightFactoryFxRate),
                      voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
                    })
                    .where(eq(vouchers.id, existingFV.id));
                  const fEntries = await tx
                    .select()
                    .from(voucherEntries)
                    .where(eq(voucherEntries.voucherId, existingFV.id));
                  for (const fe of fEntries) {
                    if (toMoney(fe.debitAmount).greaterThan(0)) {
                      // Dr Freight Expense — update amount and account
                      await tx
                        .update(voucherEntries)
                        .set({ ledgerAccountId: newFreightAcctId, ...normFreightDr })
                        .where(eq(voucherEntries.id, fe.id));
                    } else if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
                      // Cr Own account
                      await tx
                        .update(voucherEntries)
                        .set({
                          ledgerAccountId: newFreightOwnAcctId,
                          factorySupplierId: null,
                          ...normFreightCr,
                        })
                        .where(eq(voucherEntries.id, fe.id));
                    } else if (newFreightPaidBy === "supplier" && updated.freightSupplierId) {
                      // Cr Supplier
                      await tx
                        .update(voucherEntries)
                        .set({
                          factorySupplierId: updated.freightSupplierId,
                          ledgerAccountId: null,
                          ...normFreightCr,
                        })
                        .where(eq(voucherEntries.id, fe.id));
                    }
                  }
                }
              );
            } else if (updateData.arrivalDate) {
              // Date-only PATCH: keep existing entries as-is, just update the voucher date
              // so the freight voucher stays in sync with the new ETA (audited edit).
              const arrivalDate = updateData.arrivalDate;
              await editPostedFactoryVoucherTx(
                tx,
                {
                  companyId,
                  voucherIds: [existingFV.id],
                  reason: "factory-container-freight-date",
                  actor: editActor,
                  newVoucherDate: arrivalDate,
                },
                () => tx.update(vouchers).set({ voucherDate: arrivalDate }).where(eq(vouchers.id, existingFV.id))
              );
            }
            // else: nothing freight-related changed and no date → no-op
          } else if (freightNeedsSync) {
            // Create new freight voucher — only when freight fields were explicitly set.
            // A date-only PATCH should never create a freight voucher from scratch.
            // Use arrivalDate if set, else fall back to the container's own createdAt
            // (NOT today) so an edit made months later doesn't stamp a new voucher
            // with the current date. Phase 22 (C): through the engine, same posting
            // identity as the create route's freight journal.
            const today = getClientDate(req);
            const containerCreatedDate = updated.createdAt
              ? new Date(updated.createdAt).toISOString().slice(0, 10)
              : today;
            const lines: FactoryVoucherLine[] = [
              {
                ledgerAccountId: newFreightAcctId,
                debit: newFreightAmt,
                narration: `Freight expense - container ${updated.containerNumber}`,
              },
            ];
            if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
              lines.push({
                ledgerAccountId: newFreightOwnAcctId,
                credit: newFreightAmt,
                narration: `Freight paid via own account - container ${updated.containerNumber}`,
              });
            } else if (newFreightPaidBy === "supplier" && updated.freightSupplierId) {
              lines.push({
                factorySupplierId: updated.freightSupplierId,
                credit: newFreightAmt,
                narration: `Freight payable to supplier - container ${updated.containerNumber}`,
              });
            }
            await postFactoryVoucherTx(tx, {
              companyId,
              voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
              voucherNumber: `FACTORY-FREIGHT-${id}`,
              voucherDate: updated.arrivalDate || containerCreatedDate,
              description: `Freight on container ${updated.containerNumber}`,
              currency: freightCcy,
              fxRateToUsd: String(containerFreightFxRateToUsd(updated)),
              source: { sourceType: "factory-container-freight", sourceId: id, phase: "freight" },
              lines,
            });
          }
        } else if (existingFV && freightNeedsSync) {
          // Freight amount dropped to zero AND freight fields were explicitly changed →
          // delete the now-empty freight voucher.
          // (A date-only PATCH must never delete an existing freight voucher.)
          // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
          await retireVouchersTx(tx, {
            companyId,
            voucherIds: [existingFV.id],
            reason: "factory-container-freight-resync",
            actor: sessionRetirementActor(req),
          });
        }

        if (commissionNeedsSync) await syncContainerCommissionJournalTx(tx, companyId, id);
        return updated;
      });

      if (!updated) return res.status(404).json({ message: "Container not found" });

      // ── Sync CONTAINER_IMPORT daybook entry ────────────────────────────────
      // If any description-relevant fields were changed (container number, supplier,
      // quantity, rate, currency, arrival date), update the stored daybook entry so
      // the daybook always shows current data without requiring a separate migration.
      const descRelevantFields = [
        "containerNumber",
        "supplierId",
        "totalKg",
        "ratePerKg",
        "currencyCode",
        "arrivalDate",
      ];
      const touchedDescField = descRelevantFields.some((f) => f in updateData);
      if (touchedDescField) {
        let supplierNameForSync = "";
        if (updated.supplierId) {
          const [sup] = await db
            .select({ name: factorySuppliers.name })
            .from(factorySuppliers)
            .where(eq(factorySuppliers.id, updated.supplierId));
          supplierNameForSync = sup?.name || "";
        }
        const kgExact = toMoney(updated.totalKg);
        const rateExact = toMoney(updated.ratePerKg);
        const kgForSync = kgExact.toNumber();
        const rateForSync = rateExact.toNumber();
        const ccyForSync = updated.currencyCode || "USD";
        const syncDescParts = [
          updated.containerNumber,
          supplierNameForSync,
          kgForSync > 0 ? `${kgForSync.toLocaleString()} kg` : null,
          rateForSync > 0 ? `${rateForSync} ${ccyForSync}/kg` : null,
        ].filter(Boolean);
        const syncDesc = syncDescParts.join(" · ");
        const syncAmount = rateExact.times(kgExact);
        const storedFx = toMoney(updated.fxRateToUsd);
        const syncFxRate = storedFx.isZero() ? toMoney(1) : storedFx;
        const daybookUpdateSet: Partial<typeof factoryDaybookEntries.$inferInsert> = { description: syncDesc };
        if (syncAmount.greaterThan(0)) {
          daybookUpdateSet.amountCurrency = syncAmount.toFixed();
          daybookUpdateSet.amountUsd = syncAmount.times(syncFxRate).toFixed();
        }
        if ("arrivalDate" in updateData && updated.arrivalDate) {
          daybookUpdateSet.txDate = updated.arrivalDate;
        }
        await db
          .update(factoryDaybookEntries)
          .set(daybookUpdateSet)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "CONTAINER_IMPORT"),
              eq(factoryDaybookEntries.referenceId, id)
            )
          );
      }

      logger.info("factory container update succeeded", {
        module: "factoryContainers",
        action: "update",
        userId: _uid,
        companyId: _cid,
        containerId: id,
        durationMs: Date.now() - _t,
      });
      res.json(updated);
    } catch (error: unknown) {
      if (error instanceof FactoryFxRateRequiredError) return res.status(409).json(error.body);
      if (sendVoucherCorrectionRefusal(res, error)) return;
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      logger.error("factory container update failed", {
        module: "factoryContainers",
        action: "update",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      const pgErr = (error as { cause?: unknown }).cause ?? error;
      const pgMsg = getErrorMessage(pgErr) ?? getErrorMessage(error) ?? "Unknown error";
      const pgCode = (pgErr as { code?: string }).code;
      const pgConstraint = (pgErr as { constraint?: string }).constraint;
      logger.error("[factory-container PATCH] DB error:", {
        pgCode,
        pgConstraint,
        pgMsg,
        full: getErrorMessage(error),
      });
      const userMsg = pgCode
        ? `${pgMsg}${pgConstraint ? ` (constraint: ${pgConstraint})` : ""}`
        : pgMsg.split("\n\n").pop() || pgMsg;
      res.status(400).json({ message: userMsg });
    }
  });
}
