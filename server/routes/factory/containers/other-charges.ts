/**
 * factoryContainersRoutes: FactoryContainerOtherCharges endpoints.
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
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { getOrFetchFxRateToUsd, getOrCreateLedgerAccount } from "../_helpers";
import { factoryContainers, voucherEntries, factoryContainerOtherCharges, vouchers } from "@shared/schema";
import { eq, and, ilike } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";
import { parseMoneyInput, sumMoney, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

type OtherChargeInput = {
  description: string;
  amount: string;
  currencyCode?: string;
  ledgerAccountId?: number | null;
};

type PreparedCharge = {
  companyId: number;
  containerId: number;
  description: string;
  amount: string;
  currencyCode: string;
  ledgerAccountId: number | null;
  fxRate: string | null;
};

export function registerFactoryContainerOtherChargesRoutes(app: Express) {
  app.get("/api/factory/containers/:id/other-charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const charges = await db
        .select()
        .from(factoryContainerOtherCharges)
        .where(
          and(
            eq(factoryContainerOtherCharges.containerId, containerId),
            eq(factoryContainerOtherCharges.companyId, companyId)
          )
        )
        .orderBy(factoryContainerOtherCharges.createdAt);
      res.json(charges);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/containers/:id/other-charges/sync", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const { charges } = req.body as { charges?: OtherChargeInput[]; isCreate?: boolean };
      if (charges !== undefined && !Array.isArray(charges)) {
        return res.status(400).json({ message: "charges must be an array" });
      }

      // Load and scope the container before any mutation. A foreign/nonexistent
      // container must never cause old charge rows or vouchers to be removed.
      const [container] = await db
        .select({
          id: factoryContainers.id,
          supplierId: factoryContainers.supplierId,
          containerNumber: factoryContainers.containerNumber,
          currencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          fxRateConfirmed: factoryContainers.fxRateConfirmed,
          arrivalDate: factoryContainers.arrivalDate,
          createdAt: factoryContainers.createdAt,
        })
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
        .limit(1);
      if (!container) return res.status(404).json({ message: "Container not found" });

      const today = getClientDate(req);
      const containerCreatedDate = container.createdAt
        ? new Date(container.createdAt).toISOString().slice(0, 10)
        : today;
      const voucherDate = container.arrivalDate || containerCreatedDate;

      // Resolve every external dependency before the destructive portion starts.
      // In particular, unresolved FX must leave all existing rows/vouchers intact.
      const preparedCharges: PreparedCharge[] = [];
      for (const rawCharge of charges ?? []) {
        const description = rawCharge.description?.trim() ?? "";
        if (!description) return res.status(400).json({ message: "Charge description is required" });

        let ledgerAccountId = rawCharge.ledgerAccountId || null;
        if (!ledgerAccountId) {
          const code = ("OC_" + description.toUpperCase().replace(/[^A-Z0-9]/g, "_")).slice(0, 50);
          ledgerAccountId = await getOrCreateLedgerAccount(companyId, code, description);
        }

        const chargeCcy = rawCharge.currencyCode || container.currencyCode || "USD";
        const chargeAmt = parseMoneyInput(rawCharge.amount || "0");
        if (!chargeAmt) {
          return res.status(400).json({ message: `Invalid amount for ${description}` });
        }

        let fxRate: string | null = null;
        if (chargeAmt.gt(0) && ledgerAccountId) {
          if (chargeCcy === "USD") {
            fxRate = "1";
          } else if (chargeCcy === (container.currencyCode || "USD")) {
            const { fxRate: storedRate, looksSet } = resolveStoredFxRate(
              chargeCcy,
              container.fxRateToUsd,
              container.fxRateConfirmed
            );
            if (!looksSet) {
              return res.status(400).json({ message: new UnresolvedExchangeRateError(chargeCcy).message });
            }
            fxRate = String(storedRate);
          } else {
            fxRate = await getOrFetchFxRateToUsd(companyId, chargeCcy, voucherDate);
          }
        }

        preparedCharges.push({
          companyId,
          containerId,
          description,
          amount: rawCharge.amount,
          currencyCode: chargeCcy,
          ledgerAccountId,
          fxRate,
        });
      }

      const total = sumMoney(preparedCharges.map((charge) => charge.amount));
      const hasPostableCharge = preparedCharges.some(
        (charge) => toMoney(charge.amount).gt(0) && !!charge.ledgerAccountId
      );
      const payableAccId = hasPostableCharge
        ? await getOrCreateLedgerAccount(companyId, "FACTORY_CHARGES_PAYABLE", "Factory Charges Payable")
        : null;

      const result = await db.transaction(async (tx) => {
        // Void any previously created other-charge vouchers for this container
        // and replace the charge set atomically with the newly prepared set.
        const ocPrefix = `FACTORY-OC-${containerId}-%`;
        const existingVouchers = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.sourceModule, "FACTORY"),
              ilike(vouchers.voucherNumber, ocPrefix)
            )
          );
        if (existingVouchers.length > 0) {
          const voucherIds = existingVouchers.map((voucher) => voucher.id);
          // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
          await retireVouchersTx(tx, {
            companyId,
            voucherIds,
            reason: "factory-container-other-charge-delete",
            actor: sessionRetirementActor(req),
          });
        }

        await tx
          .delete(factoryContainerOtherCharges)
          .where(
            and(
              eq(factoryContainerOtherCharges.containerId, containerId),
              eq(factoryContainerOtherCharges.companyId, companyId)
            )
          );

        const insertValues = preparedCharges.map(({ fxRate: _fxRate, ...charge }) => charge);
        const newCharges =
          insertValues.length > 0 ? await tx.insert(factoryContainerOtherCharges).values(insertValues).returning() : [];

        await tx
          .update(factoryContainers)
          .set({ otherCharges: total.toFixed(2) })
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

        for (let index = 0; index < newCharges.length; index += 1) {
          const charge = newCharges[index];
          const prepared = preparedCharges[index];
          const chargeAmt = toMoney(charge.amount);
          if (chargeAmt.lte(0) || !charge.ledgerAccountId || !prepared.fxRate || !payableAccId) continue;

          const chargeCcy = charge.currencyCode || "USD";
          const ocVoucherNum = `FACTORY-OC-${containerId}-${charge.id}-${Date.now()}-${index}`;
          const [ocVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: ocVoucherNum,
              voucherDate,
              description: `${charge.description} - container ${container.containerNumber}`,
              totalAmount: chargeAmt.toFixed(),
              currency: chargeCcy,
              exchangeRate: prepared.fxRate,
              sourceModule: "FACTORY",
            })
            .returning();

          await tx.insert(voucherEntries).values([
            {
              voucherId: ocVoucher.id,
              ledgerAccountId: payableAccId,
              ...normFactoryEntry(chargeCcy, chargeAmt.toFixed(), "0", prepared.fxRate),
              narration: `${charge.description} payable - container ${container.containerNumber}`,
            },
            {
              voucherId: ocVoucher.id,
              ledgerAccountId: charge.ledgerAccountId,
              ...normFactoryEntry(chargeCcy, "0", chargeAmt.toFixed(), prepared.fxRate),
              narration: `${charge.description} - container ${container.containerNumber}`,
            },
          ]);
        }

        return newCharges;
      });

      res.json({ charges: result, total: total.toFixed(2) });
    } catch (error: unknown) {
      logger.error("Error syncing container other charges:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
