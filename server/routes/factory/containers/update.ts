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
  applyFxRate,
  UnresolvedExchangeRateError,
} from "../../../services/factory/currencyConversion";
import { getOrFetchFxRateToUsd, getOrCreateLedgerAccount } from "../_helpers";
import { factorySuppliers, factoryContainers, voucherEntries, factoryDaybookEntries, vouchers } from "@shared/schema";
import { eq, and, or, ilike } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";

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

      const b = req.body;

      // Helper: coerce empty-string / undefined to null for numeric/integer columns
      const dec = (v: unknown) => (v === "" || v === undefined || v === null ? null : String(v));
      const int = (v: unknown) => {
        if (v === "" || v === undefined || v === null) return null;
        const n = parseInt(String(v), 10);
        return isNaN(n) ? null : n;
      };
      const str = (v: unknown) => (v === "" || v === undefined ? null : String(v));

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

      // Resolve commission FX when commission amount or currency changed.
      // A partial PATCH that touches an unrelated field must preserve existing commission FX.
      const commissionChanged = b.commissionAmount !== undefined || b.commissionCurrencyCode !== undefined;
      if (commissionChanged) {
        const effCommAmt = parseFloat(
          updateData.commissionAmount !== undefined
            ? (updateData.commissionAmount ?? "0")
            : (existing.commissionAmount ?? "0")
        );
        const effCommCcy = (
          updateData.commissionCurrencyCode !== undefined
            ? updateData.commissionCurrencyCode || "USD"
            : existing.commissionCurrencyCode || "USD"
        ).toUpperCase();
        const effContainerCcy = (updateData.currencyCode || existing.currencyCode || "USD").toUpperCase();
        const effDate = updateData.arrivalDate || existing.arrivalDate || getClientDate(req);
        if (effCommAmt > 0) {
          let commFxResolved: number;
          if (effCommCcy === "USD") {
            commFxResolved = 1;
          } else if (effCommCcy === effContainerCcy) {
            // Same currency as container: use the (possibly just-updated) container FX
            const containerFxNum =
              updateData.fxRateToUsd !== undefined
                ? parseFloat(updateData.fxRateToUsd ?? "0")
                : parseFloat(existing.fxRateToUsd ?? "0");
            if (!containerFxNum || containerFxNum <= 0) {
              return res.status(400).json({
                message: `Cannot resolve commission FX for ${effCommCcy}: container FX rate is not confirmed.`,
              });
            }
            commFxResolved = containerFxNum;
          } else {
            try {
              commFxResolved = parseFloat(await getOrFetchFxRateToUsd(companyId, effCommCcy, effDate));
            } catch (err: unknown) {
              return res.status(400).json({
                message: `Cannot resolve FX rate for commission currency ${effCommCcy} on ${effDate}. ${getErrorMessage(err)}`,
              });
            }
          }
          updateData.commissionFxRateToUsd = String(commFxResolved);
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
          const fxRate = await getOrFetchFxRateToUsd(companyId, currencyCode, importDate);
          updateData.fxRateToUsd = fxRate;
          updateData.fxRateToUsdImport = fxRate;
          updateData.fxRateDateImport = importDate;
          updateData.fxRateSource = "auto";
          updateData.fxRateConfirmed = true; // real auto-fetch, not a guess
          const ratePerKg = parseFloat(updateData.ratePerKg || existing.ratePerKg || "0");
          const fxRateNum = parseFloat(fxRate);
          updateData.ratePerKgUsd = String(applyFxRate(ratePerKg, currencyCode, fxRateNum));
        } else {
          // Manual: trust an fxRateToUsd explicitly provided in THIS request regardless of
          // value; otherwise fall back to the existing stored rate, but only if it's actually
          // confirmed already (or, absent the flag on this row, looks like a real explicit
          // rate under the legacy heuristic).
          const explicitRate = b.fxRateToUsd !== undefined ? parseFloat(dec(b.fxRateToUsd) ?? "") : NaN;
          let fxRateNum: number;
          if (!isNaN(explicitRate) && explicitRate > 0) {
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
            fxRateNum = fxRate;
            // Carries forward an already-confirmed rate; leave fxRateConfirmed untouched.
          }
          const ratePerKg = parseFloat(updateData.ratePerKg || existing.ratePerKg || "0");
          updateData.fxRateToUsd = String(fxRateNum);
          updateData.fxRateToUsdImport = String(fxRateNum);
          updateData.fxRateDateImport = importDate;
          updateData.fxRateSource = "manual";
          updateData.ratePerKgUsd = String(applyFxRate(ratePerKg, currencyCode, fxRateNum));
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
      const effectiveSupplierId = updateData.supplierId !== undefined ? updateData.supplierId : existing.supplierId;

      // Auto-create freight ledger account if effective freight > 0 and no account selected
      if (!updateData.freightAccountId && parseFloat(effectiveFreight || "0") > 0) {
        updateData.freightAccountId = await getOrCreateLedgerAccount(companyId, "FREIGHT", "Freight");
      }

      // Canonicalize freight payer fields so switching "own" ↔ "supplier" never
      // leaves a stale value in the opposing field.  Rules are enforced using
      // the EFFECTIVE values (not just what was sent in this request).
      {
        const canonFreightAmt = parseFloat(effectiveFreight || "0");
        if (canonFreightAmt <= 0) {
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
          // Rule C: supplier-paid freight → require a purchase supplier, clear own account
          if (!effectiveSupplierId) {
            return res.status(400).json({
              message: "A purchase supplier (supplierId) is required when freightPaidBy is 'supplier'",
            });
          }
          updateData.freightOwnAccountId = null;
          if (!updateData.freightSupplierId) {
            updateData.freightSupplierId = effectiveSupplierId;
          }
        }
      }

      const [updated] = await db
        .update(factoryContainers)
        .set(updateData)
        .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Container not found" });

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
        "currencyCode",
        "ratePerKg",
        "fxRateToUsd",
        "fxRateSource",
      ].some((f) => f in b);

      // Find any existing freight voucher for this container (stable or timestamped number)
      const [existingFV] = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            or(
              eq(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}`),
              ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}-%`)
            )
          )
        )
        .limit(1);

      const newFreightAmt = parseFloat(updated.freight || "0");
      const newFreightAcctId = updated.freightAccountId ?? null;
      const newFreightPaidBy = updated.freightPaidBy || "supplier";
      const newFreightOwnAcctId = updated.freightOwnAccountId ?? null;
      const freightCcy = updated.freightCurrencyCode || updated.currencyCode || "USD";

      if (newFreightAmt > 0 && newFreightAcctId) {
        if (existingFV) {
          if (freightNeedsSync) {
            // Full re-sync: update voucher amount/type and re-compute entries with FX
            await db
              .update(vouchers)
              .set({
                totalAmount: String(newFreightAmt),
                voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
              })
              .where(eq(vouchers.id, existingFV.id));
            // Compute normalized amounts for the updated freight entries
            const updateFreightFactoryFxRate =
              freightCcy === (updated.currencyCode || "USD")
                ? resolveStoredFxRateOrThrow(updated.currencyCode, updated.fxRateToUsd, updated.fxRateConfirmed)
                : 1;
            const normFreightDr = normFactoryEntry(freightCcy, String(newFreightAmt), "0", updateFreightFactoryFxRate);
            const normFreightCr = normFactoryEntry(freightCcy, "0", String(newFreightAmt), updateFreightFactoryFxRate);
            // Update entries
            const fEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, existingFV.id));
            for (const fe of fEntries) {
              if (parseFloat(fe.debitAmount || "0") > 0) {
                // Dr Freight Expense — update amount and account
                await db
                  .update(voucherEntries)
                  .set({ ledgerAccountId: newFreightAcctId, ...normFreightDr })
                  .where(eq(voucherEntries.id, fe.id));
              } else if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
                // Cr Own account
                await db
                  .update(voucherEntries)
                  .set({
                    ledgerAccountId: newFreightOwnAcctId,
                    factorySupplierId: null,
                    ...normFreightCr,
                  })
                  .where(eq(voucherEntries.id, fe.id));
              } else if (newFreightPaidBy === "supplier" && updated.supplierId) {
                // Cr Supplier
                await db
                  .update(voucherEntries)
                  .set({
                    factorySupplierId: updated.supplierId,
                    ledgerAccountId: null,
                    ...normFreightCr,
                  })
                  .where(eq(voucherEntries.id, fe.id));
              }
            }
          } else if (updateData.arrivalDate) {
            // Date-only PATCH: keep existing entries as-is, just update the voucher date
            // so the freight voucher stays in sync with the new ETA.
            await db
              .update(vouchers)
              .set({ voucherDate: updateData.arrivalDate })
              .where(eq(vouchers.id, existingFV.id));
          }
          // else: nothing freight-related changed and no date → no-op
        } else if (freightNeedsSync) {
          // Create new freight voucher — only when freight fields were explicitly set.
          // A date-only PATCH should never create a freight voucher from scratch.
          // Use arrivalDate if set, else fall back to the container's own createdAt
          // (NOT today) so an edit made months later doesn't stamp a new voucher
          // with the current date.
          const today = getClientDate(req);
          const containerCreatedDate = updated.createdAt
            ? new Date(updated.createdAt).toISOString().slice(0, 10)
            : today;
          const [newFV] = await db
            .insert(vouchers)
            .values({
              companyId,
              voucherType: newFreightPaidBy === "own" ? "Payment" : "Journal",
              voucherNumber: `FACTORY-FREIGHT-${id}`,
              voucherDate: updated.arrivalDate || containerCreatedDate,
              description: `Freight on container ${updated.containerNumber}`,
              totalAmount: String(newFreightAmt),
              currency: freightCcy,
              sourceModule: "FACTORY",
            })
            .returning();
          const newFreightFactoryFxRate =
            freightCcy === (updated.currencyCode || "USD")
              ? resolveStoredFxRateOrThrow(updated.currencyCode, updated.fxRateToUsd, updated.fxRateConfirmed)
              : 1;
          await db.insert(voucherEntries).values({
            voucherId: newFV.id,
            ledgerAccountId: newFreightAcctId,
            ...normFactoryEntry(freightCcy, String(newFreightAmt), "0", newFreightFactoryFxRate),
            narration: `Freight expense - container ${updated.containerNumber}`,
          });
          if (newFreightPaidBy === "own" && newFreightOwnAcctId) {
            await db.insert(voucherEntries).values({
              voucherId: newFV.id,
              ledgerAccountId: newFreightOwnAcctId,
              ...normFactoryEntry(freightCcy, "0", String(newFreightAmt), newFreightFactoryFxRate),
              narration: `Freight paid via own account - container ${updated.containerNumber}`,
            });
          } else if (newFreightPaidBy === "supplier" && updated.supplierId) {
            await db.insert(voucherEntries).values({
              voucherId: newFV.id,
              factorySupplierId: updated.supplierId,
              ...normFactoryEntry(freightCcy, "0", String(newFreightAmt), newFreightFactoryFxRate),
              narration: `Freight payable to supplier - container ${updated.containerNumber}`,
            });
          }
        }
      } else if (existingFV && freightNeedsSync) {
        // Freight amount dropped to zero AND freight fields were explicitly changed →
        // delete the now-empty freight voucher.
        // (A date-only PATCH must never delete an existing freight voucher.)
        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, existingFV.id));
        await db.delete(vouchers).where(eq(vouchers.id, existingFV.id));
      }

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
        const kgForSync = parseFloat(updated.totalKg || "0");
        const rateForSync = parseFloat(updated.ratePerKg || "0");
        const ccyForSync = updated.currencyCode || "USD";
        const syncDescParts = [
          updated.containerNumber,
          supplierNameForSync,
          kgForSync > 0 ? `${kgForSync.toLocaleString()} kg` : null,
          rateForSync > 0 ? `${rateForSync} ${ccyForSync}/kg` : null,
        ].filter(Boolean);
        const syncDesc = syncDescParts.join(" · ");
        const syncAmount = rateForSync * kgForSync;
        const syncFxRate = parseFloat(updated.fxRateToUsd || "1") || 1;
        const daybookUpdateSet: Partial<typeof factoryDaybookEntries.$inferInsert> = { description: syncDesc };
        if (syncAmount > 0) {
          daybookUpdateSet.amountCurrency = String(syncAmount);
          daybookUpdateSet.amountUsd = String(syncAmount * syncFxRate);
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
