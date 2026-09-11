/**
 * factoryContainersRoutes: FactoryContainerOtherChargesCurrencyAdmin endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { getOrCreateLedgerAccount } from "../_helpers";
import {
  factoryContainers,
  voucherEntries,
  factoryDaybookEntries,
  factoryContainerOtherCharges,
  vouchers,
} from "@shared/schema";
import { eq, and, sql, inArray, ilike, ne } from "drizzle-orm";
import { normFactoryEntry } from "./_helpers";

export function registerFactoryContainerOtherChargesCurrencyAdminRoutes(app: Express) {
  // Preview and apply are both administrative repair operations. Developer is
  // accepted by requireRole's global bypass; ordinary authenticated users are not.
  app.get(
    "/api/factory/admin/other-charges-currency-preview",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const nonUsdContainerCharges = await db
          .select({
            id: factoryContainers.id,
            containerNumber: factoryContainers.containerNumber,
            otherCharges: factoryContainers.otherCharges,
            currencyCode: factoryContainers.currencyCode,
            otherChargesSupplierId: factoryContainers.otherChargesSupplierId,
          })
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.companyId, companyId),
              sql`${factoryContainers.otherCharges}::numeric > 0`,
              sql`${factoryContainers.otherChargesSupplierId} IS NOT NULL`,
              sql`(other_charges_currency_code IS NULL OR other_charges_currency_code != 'USD')`,
              ne(factoryContainers.currencyCode, "USD")
            )
          )
          .orderBy(factoryContainers.containerNumber);

        const nonUsdTableCharges = await db
          .select({
            id: factoryContainerOtherCharges.id,
            containerId: factoryContainerOtherCharges.containerId,
            description: factoryContainerOtherCharges.description,
            amount: factoryContainerOtherCharges.amount,
            currencyCode: factoryContainerOtherCharges.currencyCode,
            containerNumber: factoryContainers.containerNumber,
          })
          .from(factoryContainerOtherCharges)
          .leftJoin(factoryContainers, eq(factoryContainers.id, factoryContainerOtherCharges.containerId))
          .where(
            and(
              eq(factoryContainerOtherCharges.companyId, companyId),
              ne(factoryContainerOtherCharges.currencyCode, "USD")
            )
          );

        const grouped = new Map<
          number,
          {
            containerId: number;
            containerNumber: string;
            currentCurrency: string | null;
            amount: string | null;
            charges: unknown[];
          }
        >();

        for (const row of nonUsdContainerCharges) {
          grouped.set(row.id, {
            containerId: row.id,
            containerNumber: row.containerNumber,
            currentCurrency: row.currencyCode,
            amount: row.otherCharges,
            charges: [
              { description: "Container Other Charges", amount: row.otherCharges, currencyCode: row.currencyCode },
            ],
          });
        }
        for (const row of nonUsdTableCharges) {
          if (!grouped.has(row.containerId)) {
            grouped.set(row.containerId, {
              containerId: row.containerId,
              containerNumber: row.containerNumber || String(row.containerId),
              currentCurrency: row.currencyCode,
              amount: "0",
              charges: [],
            });
          }
          grouped.get(row.containerId)!.charges.push({
            id: row.id,
            description: row.description,
            amount: row.amount,
            currencyCode: row.currencyCode,
          });
        }

        res.json({ containers: Array.from(grouped.values()) });
      } catch (error: unknown) {
        logger.error("Error previewing other charges currency:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/admin/fix-other-charges-currency",
    requireAuth,
    requireRole("Admin"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { containerIds } = req.body as { containerIds: number[] };
        if (!Array.isArray(containerIds) || containerIds.length === 0) {
          return res.status(400).json({ message: "No container IDs provided" });
        }
        if (containerIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
          return res.status(400).json({ message: "Invalid container ID" });
        }

        // Account creation is idempotent and happens before any repair mutation.
        // Every selected container is then repaired in its own DB transaction, so
        // voucher/daybook/charge updates cannot be partially committed.
        const payableAccId = await getOrCreateLedgerAccount(
          companyId,
          "FACTORY_CHARGES_PAYABLE",
          "Factory Charges Payable"
        );
        let fixed = 0;

        for (const rawContainerId of containerIds) {
          const containerId = Number(rawContainerId);
          const repaired = await db.transaction(async (tx) => {
            const [container] = await tx
              .select({
                id: factoryContainers.id,
                containerNumber: factoryContainers.containerNumber,
                arrivalDate: factoryContainers.arrivalDate,
                createdAt: factoryContainers.createdAt,
              })
              .from(factoryContainers)
              .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
              .limit(1);
            if (!container) return false;

            const tableCharges = await tx
              .select()
              .from(factoryContainerOtherCharges)
              .where(
                and(
                  eq(factoryContainerOtherCharges.containerId, containerId),
                  eq(factoryContainerOtherCharges.companyId, companyId),
                  ne(factoryContainerOtherCharges.currencyCode, "USD")
                )
              );

            await tx.execute(
              sql`UPDATE factory_containers SET other_charges_currency_code = 'USD' WHERE id = ${containerId} AND company_id = ${companyId}`
            );

            await tx
              .update(factoryDaybookEntries)
              .set({
                currencyCode: "USD",
                fxRateToUsd: "1",
                amountUsd: sql`${factoryDaybookEntries.amountCurrency}`,
              })
              .where(
                and(
                  eq(factoryDaybookEntries.companyId, companyId),
                  eq(factoryDaybookEntries.txType, "OTHER_CHARGE"),
                  eq(factoryDaybookEntries.referenceId, containerId),
                  ne(factoryDaybookEntries.currencyCode, "USD")
                )
              );

            if (tableCharges.length > 0) {
              await tx
                .update(factoryContainerOtherCharges)
                .set({ currencyCode: "USD" })
                .where(
                  and(
                    eq(factoryContainerOtherCharges.containerId, containerId),
                    eq(factoryContainerOtherCharges.companyId, companyId)
                  )
                );

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
                await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, voucherIds));
                await tx.delete(vouchers).where(inArray(vouchers.id, voucherIds));
              }

              const today = getClientDate(req);
              const containerCreatedDate = container.createdAt
                ? new Date(container.createdAt).toISOString().slice(0, 10)
                : today;
              const voucherDate = container.arrivalDate || containerCreatedDate;

              for (const charge of tableCharges) {
                const chargeAmt = parseFloat(charge.amount || "0");
                if (chargeAmt <= 0 || !charge.ledgerAccountId) continue;
                const ocVoucherNum = `FACTORY-OC-${containerId}-${charge.id}-${Date.now()}`;
                const [ocVoucher] = await tx
                  .insert(vouchers)
                  .values({
                    companyId,
                    voucherType: "Journal",
                    voucherNumber: ocVoucherNum,
                    voucherDate,
                    description: `${charge.description} - container ${container.containerNumber}`,
                    totalAmount: String(chargeAmt),
                    currency: "USD",
                    exchangeRate: "1",
                    sourceModule: "FACTORY",
                  })
                  .returning();

                await tx.insert(voucherEntries).values([
                  {
                    voucherId: ocVoucher.id,
                    ledgerAccountId: payableAccId,
                    ...normFactoryEntry("USD", String(chargeAmt), "0", null),
                    narration: `${charge.description} payable`,
                  },
                  {
                    voucherId: ocVoucher.id,
                    ledgerAccountId: charge.ledgerAccountId,
                    ...normFactoryEntry("USD", "0", String(chargeAmt), null),
                    narration: `${charge.description}`,
                  },
                ]);
              }
            }

            return true;
          });

          if (repaired) fixed += 1;
        }

        res.json({ fixed });
      } catch (error: unknown) {
        logger.error("Error fixing other charges currency:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
