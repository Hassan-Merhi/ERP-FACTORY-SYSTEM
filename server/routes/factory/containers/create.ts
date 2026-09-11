/**
 * factoryContainersRoutes: FactoryContainerCreate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { resolveStoredFxRateOrThrow } from "../../../services/factory/currencyConversion";
import { writeDaybookEntry, getOrFetchFxRateToUsd, getOrCreateLedgerAccount } from "../_helpers";
import {
  factorySuppliers,
  factoryContainers,
  insertFactoryContainerSchema,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";

export function registerFactoryContainerCreateRoutes(app: Express) {
  app.post("/api/factory/containers", requireAuth, async (req: Request, res: Response) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.factoryCompanyId || req.session.currentCompanyId;
    try {
      logger.info("factory container create started", {
        module: "factoryContainers",
        action: "create",
        userId: _uid,
        companyId: _cid,
      });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertFactoryContainerSchema.parse({ ...req.body, companyId });
      const currencyCode = parsed.currencyCode || "USD";
      const fxRateSource = parsed.fxRateSource || "auto";
      const today = getClientDate(req);
      const importDate = parsed.arrivalDate || today;

      let fxRate: string;
      if (fxRateSource === "manual" && parsed.fxRateToUsd) {
        fxRate = parsed.fxRateToUsd;
      } else {
        fxRate = await getOrFetchFxRateToUsd(companyId, currencyCode, importDate);
      }

      const ratePerKg = parseFloat(parsed.ratePerKg || "0");
      const fxRateNum = parseFloat(fxRate);
      const ratePerKgUsd = currencyCode === "USD" ? ratePerKg : ratePerKg * fxRateNum;

      const values = {
        ...parsed,
        currencyCode,
        fxRateToUsd: fxRate,
        fxRateToUsdImport: fxRate,
        fxRateSource: fxRateSource === "manual" ? "manual" : "auto",
        fxRateDateImport: importDate,
        ratePerKgUsd: String(ratePerKgUsd),
        // Explicitly resolved above (manual user entry or a real auto-fetch) — trust it.
        fxRateConfirmed: true,
      };

      // Auto-set commissionSupplierId to broker (parentId) if supplier has one and not already set
      if (parsed.supplierId && !parsed.commissionSupplierId) {
        const [sup] = await db
          .select({ parentId: factorySuppliers.parentId })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.id, parsed.supplierId));
        if (sup?.parentId) values.commissionSupplierId = sup.parentId;
      }

      // Guard: verify the commission supplier actually exists in factory_suppliers.
      // The FK factory_containers_commission_supplier_id_fkey enforces referential integrity,
      // so an orphaned/stale commissionSupplierId (e.g. a supplier deleted after the form
      // was opened, or a parentId pointing to a non-existent broker row) would cause a
      // hard FK-violation INSERT failure. Null it out gracefully instead.
      if (values.commissionSupplierId) {
        const [commSupExists] = await db
          .select({ id: factorySuppliers.id })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.id, values.commissionSupplierId));
        if (!commSupExists) {
          logger.warn("commissionSupplierId not found in factory_suppliers — clearing to avoid FK violation", {
            module: "factoryContainers",
            action: "create",
            commissionSupplierId: values.commissionSupplierId,
          });
          values.commissionSupplierId = null;
          values.commissionAccountId = null;
        }
      }

      // Auto-create commission ledger account for the broker if commission amount > 0
      const commissionAmt = parseFloat(values.commissionAmount || "0");
      if (!values.commissionAccountId && values.commissionSupplierId) {
        const [broker] = await db
          .select({ id: factorySuppliers.id, name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.id, values.commissionSupplierId));
        if (broker) {
          const safeCode = `COMM_SUP_${broker.id}`;
          values.commissionAccountId = await getOrCreateLedgerAccount(
            companyId,
            safeCode,
            `Commission Payable - ${broker.name}`,
            "LIABILITY"
          );
        }
      }

      // Resolve commission FX independently — the commission may be in a different
      // currency than both USD and the container (e.g. AUD container, EUR commission).
      // Using the container fxRateToUsd for that case gives a wrong commissionTotalUsd.
      const commFxCcy = (values.commissionCurrencyCode || currencyCode || "USD").toUpperCase();
      const containerCcyUpper = (currencyCode || "USD").toUpperCase();
      if (commissionAmt > 0) {
        let commFxResolved: number;
        if (commFxCcy === "USD") {
          commFxResolved = 1;
        } else if (commFxCcy === containerCcyUpper) {
          // Same currency as container — container FX is correct
          commFxResolved = parseFloat(fxRate);
        } else {
          // Different non-USD currency: resolve independently
          try {
            commFxResolved = parseFloat(await getOrFetchFxRateToUsd(companyId, commFxCcy, importDate));
          } catch (err: unknown) {
            return res.status(400).json({
              message: `Cannot resolve FX rate for commission currency ${commFxCcy} on ${importDate}. ${getErrorMessage(err)}`,
            });
          }
        }
        values.commissionFxRateToUsd = String(commFxResolved);
        values.commissionFxRateConfirmed = true;
        values.commissionFxRateDate = importDate;
      } else {
        values.commissionFxRateToUsd = null;
        values.commissionFxRateConfirmed = false;
        values.commissionFxRateDate = null;
      }

      // Auto-create freight ledger account if freight > 0 and no account selected
      if (!values.freightAccountId && parseFloat(values.freight || "0") > 0) {
        values.freightAccountId = await getOrCreateLedgerAccount(companyId, "FREIGHT", "Freight");
      }

      // Canonicalize freight payer fields on create.
      // Rule A — No freight (amount <= 0): clear both payer fields unconditionally.
      // Rule B — Own Account: require freightOwnAccountId, clear supplier link.
      // Rule C — By Supplier: require a purchase supplier, clear own account, auto-fill freightSupplierId.
      const freightPaidByOnCreate = values.freightPaidBy || "supplier";
      const freightAmtOnCreate = parseFloat(values.freight || "0");
      if (freightAmtOnCreate <= 0) {
        // Rule A: no freight → clear both
        values.freightSupplierId = null;
        values.freightOwnAccountId = null;
      } else if (freightPaidByOnCreate === "own") {
        // Rule B: own-account
        if (!values.freightOwnAccountId) {
          return res.status(400).json({ message: "freightOwnAccountId is required when freightPaidBy is 'own'" });
        }
        values.freightSupplierId = null;
      } else {
        // Rule C: supplier-paid (default)
        if (!values.supplierId && !values.freightSupplierId) {
          return res
            .status(400)
            .json({ message: "A purchase supplier is required when freightPaidBy is 'supplier' and freight > 0" });
        }
        values.freightOwnAccountId = null;
        if (!values.freightSupplierId && values.supplierId) {
          values.freightSupplierId = values.supplierId;
        }
      }

      const [container] = await db.insert(factoryContainers).values(values).returning();

      let supplierNameForDesc = "";
      if (container.supplierId) {
        const [sup] = await db
          .select({ name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(eq(factorySuppliers.id, container.supplierId));
        supplierNameForDesc = sup?.name || "";
      }
      const kgForDesc = parseFloat(container.totalKg || "0");
      const rateForDesc = parseFloat(container.ratePerKg || "0");
      const ccyForDesc = container.currencyCode || "USD";
      const descParts = [
        container.containerNumber,
        supplierNameForDesc,
        kgForDesc > 0 ? `${kgForDesc.toLocaleString()} kg` : null,
        rateForDesc > 0 ? `${rateForDesc} ${ccyForDesc}/kg` : null,
      ].filter(Boolean);

      await writeDaybookEntry(db, {
        companyId,
        txDate: container.arrivalDate || today,
        txType: "CONTAINER_IMPORT",
        referenceId: container.id,
        referenceTable: "factory_containers",
        description: descParts.join(" · "),
        currencyCode: ccyForDesc,
        amountCurrency: parseFloat(container.ratePerKg || "0") * parseFloat(container.totalKg || "0"),
        fxRateToUsd: resolveStoredFxRateOrThrow(ccyForDesc, container.fxRateToUsd, container.fxRateConfirmed),
      });

      // Double-entry: Goods value — Dr Factory Import Cost / Cr Supplier Payable
      const goodsValue = parseFloat(container.ratePerKg || "0") * parseFloat(container.totalKg || "0");
      if (goodsValue > 0 && container.supplierId) {
        const importCostAccId = await getOrCreateLedgerAccount(companyId, "FACTORY_IMPORT_COST", "Factory Import Cost");
        const importVoucherNum = `FACTORY-IMPORT-${container.id}-${Date.now()}`;
        const [importVoucher] = await db
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: importVoucherNum,
            voucherDate: container.arrivalDate || today,
            description: `Goods import - container ${container.containerNumber}`,
            totalAmount: String(goodsValue),
            currency: container.currencyCode || "USD",
            exchangeRate: String(
              resolveStoredFxRateOrThrow(container.currencyCode, container.fxRateToUsd, container.fxRateConfirmed)
            ),
            sourceModule: "FACTORY",
          })
          .returning();
        const importFactoryFxRate = resolveStoredFxRateOrThrow(
          container.currencyCode,
          container.fxRateToUsd,
          container.fxRateConfirmed
        );
        await db.insert(voucherEntries).values({
          voucherId: importVoucher.id,
          ledgerAccountId: importCostAccId,
          ...normFactoryEntry(container.currencyCode || "USD", String(goodsValue), "0", importFactoryFxRate),
          narration: `Goods import cost - container ${container.containerNumber}`,
        });
        await db.insert(voucherEntries).values({
          voucherId: importVoucher.id,
          factorySupplierId: container.supplierId,
          ...normFactoryEntry(container.currencyCode || "USD", "0", String(goodsValue), importFactoryFxRate),
          narration: `Goods payable to supplier - container ${container.containerNumber}`,
        });
      }

      // Commission is already included in the factory supplier balance calculation
      // (via container.commissionAmount in the supplier liability formula).
      // Posting a separate journal voucher would double-count it, so we skip it here.

      // Double-entry: Freight
      // If freightPaidBy='own': Dr Freight Expense / Cr own ledger account
      // If freightPaidBy='supplier' (default): Dr Freight Expense / Cr Supplier Payable
      const freightAmt = parseFloat(container.freight || "0");
      const freightCcy = container.freightCurrencyCode || container.currencyCode || "USD";
      const freightPaidBy = container.freightPaidBy || "supplier";
      const freightOwnAcctId = container.freightOwnAccountId ?? null;
      if (freightAmt > 0 && container.freightAccountId) {
        const freightVoucherNum = `FACTORY-FREIGHT-${container.id}`;
        const [freightVoucher] = await db
          .insert(vouchers)
          .values({
            companyId,
            voucherType: freightPaidBy === "own" ? "Payment" : "Journal",
            voucherNumber: freightVoucherNum,
            voucherDate: container.arrivalDate || today,
            description: `Freight on container ${container.containerNumber}`,
            totalAmount: String(freightAmt),
            currency: freightCcy,
            exchangeRate:
              freightCcy === (container.currencyCode || "USD")
                ? String(
                    resolveStoredFxRateOrThrow(container.currencyCode, container.fxRateToUsd, container.fxRateConfirmed)
                  )
                : "1",
            sourceModule: "FACTORY",
          })
          .returning();
        // Compute factory freight FX rate (BASE_PER_TRANSACTION: USD per foreign)
        const freightFactoryFxRate =
          freightCcy === (container.currencyCode || "USD")
            ? resolveStoredFxRateOrThrow(container.currencyCode, container.fxRateToUsd, container.fxRateConfirmed)
            : 1; // USD-denominated freight — treat as USD-equivalent
        // Dr Freight Expense
        await db.insert(voucherEntries).values({
          voucherId: freightVoucher.id,
          ledgerAccountId: container.freightAccountId,
          ...normFactoryEntry(freightCcy, String(freightAmt), "0", freightFactoryFxRate),
          narration: `Freight expense - container ${container.containerNumber}`,
        });
        if (freightPaidBy === "own" && freightOwnAcctId) {
          // Cr Own account (paid by company itself)
          await db.insert(voucherEntries).values({
            voucherId: freightVoucher.id,
            ledgerAccountId: freightOwnAcctId,
            ...normFactoryEntry(freightCcy, "0", String(freightAmt), freightFactoryFxRate),
            narration: `Freight paid via own account - container ${container.containerNumber}`,
          });
        } else if (freightPaidBy === "supplier" && container.supplierId) {
          // Cr Supplier Payable
          await db.insert(voucherEntries).values({
            voucherId: freightVoucher.id,
            factorySupplierId: container.supplierId,
            ...normFactoryEntry(freightCcy, "0", String(freightAmt), freightFactoryFxRate),
            narration: `Freight payable to supplier - container ${container.containerNumber}`,
          });
        }
      }

      logger.info("factory container create succeeded", {
        module: "factoryContainers",
        action: "create",
        userId: _uid,
        companyId: _cid,
        containerId: container.id,
        durationMs: Date.now() - _t,
      });
      res.json(container);
    } catch (error: unknown) {
      logger.error("factory container create failed", {
        module: "factoryContainers",
        action: "create",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("Error creating factory container:", { error: error });
      const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; detail?: string };
      if (cause?.code === "23505" && cause?.detail?.includes("container_number")) {
        return res
          .status(409)
          .json({ message: "A container with this number already exists. Please use a different container number." });
      }
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
