/**
 * factoryContainersRoutes: FactoryContainerDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { checkFactoryAdmin } from "../_helpers";
import {
  factoryContainers,
  factoryRawStock,
  factoryContainerCommissions,
  factoryDaybookEntries,
  vouchers,
} from "@shared/schema";
import { eq, and, or, inArray, ilike, isNull } from "drizzle-orm";
import { removeContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { registerFactoryContainerDeleteRoutesPart1 } from "./registerFactoryContainerDeleteRoutesPart1";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// ids stays optional so the handler keeps its "No container IDs provided" answer.
const bulkDeleteContainersInput = {
  query: emptyQuery,
  body: z.strictObject({ ids: z.array(z.number()).optional() }),
} satisfies RequestSchemas;

const deleteContainerInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerFactoryContainerDeleteRoutes(app: Express) {
  // ── Bulk cascade-delete containers ───────────────────────────────────────────
  app.post(
    "/api/factory/containers/bulk-delete",
    requireAuth,
    validateRequest(bulkDeleteContainersInput),
    async (req: Request, res: Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { ids } = req.body as { ids: number[] };
        if (!Array.isArray(ids) || ids.length === 0)
          return res.status(400).json({ message: "No container IDs provided" });

        // Verify all containers belong to this company
        const owned = await db
          .select({ id: factoryContainers.id })
          .from(factoryContainers)
          .where(
            and(
              inArray(factoryContainers.id, ids),
              eq(factoryContainers.companyId, companyId),
              isNull(factoryContainers.deletedAt)
            )
          );
        const ownedIds = owned.map((c) => c.id);
        if (ownedIds.length === 0) return res.status(404).json({ message: "No containers found" });

        // Soft-delete: hide containers from main listings while preserving all child rows
        // (raw stock, vouchers, daybook, etc.) so they can be restored from Settings → Deleted Items.
        // Permanent deletion (with the original cascade) is performed from the admin trash UI.
        await db
          .update(factoryContainers)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(inArray(factoryContainers.id, ownedIds), eq(factoryContainers.companyId, companyId)));

        // Soft delete only. The cascade that used to follow this line — daybook
        // entries, vouchers, charges, raw stock and the container rows
        // themselves — sat after an unconditional `return` and had been
        // unreachable for as long as that return was there. Removed rather than
        // left in place: the single-container DELETE below *does* cascade its
        // vouchers, so a long dead cascade sitting in the bulk handler read as
        // though this one did too. Permanent deletion is performed from the
        // admin trash UI.
        res.json({ deleted: ownedIds.length, ids: ownedIds });
      } catch (error: unknown) {
        logger.error("Error bulk-deleting factory containers:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/containers/:id",
    requireAuth,
    validateRequest(deleteContainerInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, deleteContainerInput).params;

        let updatedId: number | null = null;
        await db.transaction(async (tx) => {
          // Soft-delete the container
          const [updated] = await tx
            .update(factoryContainers)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(factoryContainers.id, id),
                eq(factoryContainers.companyId, companyId),
                isNull(factoryContainers.deletedAt)
              )
            )
            .returning({ id: factoryContainers.id });
          if (!updated) return;
          updatedId = updated.id;

          // 1. Collect child IDs for daybook cleanup
          const rsRows = await tx
            .select({ id: factoryRawStock.id })
            .from(factoryRawStock)
            .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, id)));
          const rsIds = rsRows.map((r) => r.id);

          const commRows = await tx
            .select({ id: factoryContainerCommissions.id })
            .from(factoryContainerCommissions)
            .where(
              and(eq(factoryContainerCommissions.companyId, companyId), eq(factoryContainerCommissions.containerId, id))
            );
          const commIds = commRows.map((r) => r.id);

          // 2. Delete daybook entries linked to this container
          if (rsIds.length > 0) {
            await tx
              .delete(factoryDaybookEntries)
              .where(
                and(
                  eq(factoryDaybookEntries.companyId, companyId),
                  eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                  inArray(factoryDaybookEntries.referenceId, rsIds)
                )
              );
          }
          if (commIds.length > 0) {
            await tx
              .delete(factoryDaybookEntries)
              .where(
                and(
                  eq(factoryDaybookEntries.companyId, companyId),
                  eq(factoryDaybookEntries.txType, "COMMISSION"),
                  inArray(factoryDaybookEntries.referenceId, commIds)
                )
              );
          }
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                inArray(factoryDaybookEntries.txType, [
                  "FREIGHT",
                  "OTHER_CHARGE",
                  "DUTY",
                  "CONTAINER_IMPORT",
                  "PURCHASE",
                ]),
                eq(factoryDaybookEntries.referenceId, id)
              )
            );

          // 3. Delete accounting vouchers and their entries. The commission
          // journal FACTORY-COMM-{container} carries a posting identity, so it is
          // removed with it (wave 8.4 continuation).
          await removeContainerCommissionJournalTx(tx, companyId, id);
          const containerVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                eq(vouchers.sourceModule, "FACTORY"),
                or(
                  ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${id}-%`),
                  ilike(vouchers.voucherNumber, `FACTORY-COMM-${id}-%`),
                  ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}-%`),
                  ilike(vouchers.voucherNumber, `FACTORY-OC-${id}-%`)
                )
              )
            );
          if (containerVouchers.length > 0) {
            const vIds = containerVouchers.map((v) => v.id);
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersTx(tx, {
              companyId,
              voucherIds: vIds,
              reason: "factory-container-delete",
              actor: sessionRetirementActor(req),
            });
          }
        });

        if (!updatedId) return res.status(404).json({ message: "Container not found" });
        res.json({ id: updatedId, message: "Container deleted" });
      } catch (error: unknown) {
        logger.error("Error deleting factory container:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  registerFactoryContainerDeleteRoutesPart1(app);
}
