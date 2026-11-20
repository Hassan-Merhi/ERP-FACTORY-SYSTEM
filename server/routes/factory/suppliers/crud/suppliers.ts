/**
 * supplierCrudRoutes: FactorySupplierCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { errorStatus, getErrorMessage } from "../../../../lib/httpHandlers";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../../lib/validateRequest";
import {
  createFactorySupplierTx,
  factorySupplierUpdateSchema,
  parseFactorySupplierOpening,
  updateFactorySupplierTx,
} from "./factorySupplierWrites";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth, requireRole } from "../../../../auth";
import { logAudit } from "../../../_helpers";
import { toMoney } from "../../../../lib/money";
import { factorySuppliers, factorySupplierScoreSnapshots, insertFactorySupplierSchema } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  FACTORY_SUPPLIER_HAS_HISTORY_CODE,
  FACTORY_SUPPLIER_HAS_HISTORY_MESSAGE,
  factorySupplierHistoryCountsTx,
  factorySupplierActor,
  sendFactorySupplierWriteError,
} from "./suppliersHelpers";

// The create and update paths still re-parse with the insert schema
// (factorySupplierWrites.ts); these add unknown-field rejection. companyId
// comes from the session on create. parseId() still checks the ids.
const createSupplierInput = {
  query: emptyQuery,
  body: insertFactorySupplierSchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

const updateSupplierInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: factorySupplierUpdateSchema
    .extend({
      id: z.unknown().optional(), // sent by client/src/pages/factory/factory-suppliers (SupplierPatch); not used
    })
    .strict(),
} satisfies RequestSchemas;

const supplierActionInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

const supplierOpeningInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({ openingBalance: z.union([z.string(), z.number()]).nullable().optional() }),
} satisfies RequestSchemas;

const setBrokerInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({ isBroker: z.boolean() }),
} satisfies RequestSchemas;

export {
  FACTORY_SUPPLIER_HAS_HISTORY_CODE,
  FACTORY_SUPPLIER_HAS_HISTORY_MESSAGE,
  factorySupplierHistoryCountsTx,
} from "./suppliersHelpers";

export function registerFactorySupplierCrudRoutes(app: Express) {
  app.get("/api/factory/suppliers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select()
        .from(factorySuppliers)
        .where(eq(factorySuppliers.companyId, companyId))
        .orderBy(factorySuppliers.name);

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/suppliers",
    requireAuth,
    validateRequest(createSupplierInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const supplier = await db.transaction((tx) =>
          createFactorySupplierTx(tx, companyId, req.body, factorySupplierActor(req))
        );
        res.json(supplier);
      } catch (error: unknown) {
        logger.error("Error creating factory supplier:", { error: error });
        sendFactorySupplierWriteError(res, error, 400);
      }
    }
  );

  app.patch(
    "/api/factory/suppliers/:id",
    requireAuth,
    validateRequest(updateSupplierInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);

        if (id === null) return res.status(400).json({ message: "Invalid id" });
        // Wave 16 (B): only the supplier's own editable fields, under the
        // history rules, audited in the transaction (the raw body used to be
        // written as is, any column included).
        const updates = factorySupplierUpdateSchema.parse(req.body ?? {});
        const updated = await db.transaction((tx) =>
          updateFactorySupplierTx(tx, companyId, id, updates, factorySupplierActor(req))
        );

        if (!updated) return res.status(404).json({ message: "Supplier not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error updating factory supplier:", { error: error });
        sendFactorySupplierWriteError(res, error, 400);
      }
    }
  );

  app.delete(
    "/api/factory/suppliers/:id",
    requireAuth,
    validateRequest(supplierActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);

        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const [updated] = await db
          .update(factorySuppliers)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
          .returning();

        if (!updated) return res.status(404).json({ message: "Supplier not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error deleting factory supplier:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.patch(
    "/api/factory/suppliers/:id/reactivate",
    requireAuth,
    validateRequest(supplierActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const [updated] = await db
          .update(factorySuppliers)
          .set({ isActive: true, updatedAt: new Date() })
          .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
          .returning();
        if (!updated) return res.status(404).json({ message: "Supplier not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error reactivating factory supplier:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Overwrite a factory supplier's opening balance
  app.patch(
    "/api/factory/suppliers/:id/opening-balance",
    requireAuth,
    validateRequest(supplierOpeningInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);

        if (id === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(id)) return res.status(400).json({ message: "Invalid supplier id" });

        const { openingBalance } = req.body;
        if (openingBalance === undefined || openingBalance === null || openingBalance === "") {
          return res.status(400).json({ message: "openingBalance is required" });
        }

        const updated = await db.transaction((tx) =>
          updateFactorySupplierTx(
            tx,
            companyId,
            id,
            { openingBalance: parseFactorySupplierOpening(openingBalance) },
            factorySupplierActor(req)
          )
        );
        if (!updated) return res.status(404).json({ message: "Supplier not found" });

        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error updating supplier opening balance:", { error: error });
        sendFactorySupplierWriteError(res, error, 500);
      }
    }
  );

  // Mark / unmark a supplier as broker (explicit flag, independent of whether children exist)
  app.patch(
    "/api/factory/suppliers/:id/set-broker",
    requireAuth,
    validateRequest(setBrokerInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const { isBroker } = req.body;
        if (typeof isBroker !== "boolean") return res.status(400).json({ message: "isBroker must be boolean" });
        // A broker cannot itself have a parent (it IS the parent)
        if (isBroker) {
          const [sup] = await db
            .select({ parentId: factorySuppliers.parentId })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          if (sup?.parentId) {
            return res.status(400).json({
              message: "A linked supplier (child) cannot be set as broker directly. Remove the parent link first.",
            });
          }
        }
        const [updated] = await db
          .update(factorySuppliers)
          .set({ isBroker, updatedAt: new Date() })
          .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
          .returning();
        if (!updated) return res.status(404).json({ message: "Supplier not found" });
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error setting broker flag:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Permanent delete of a factory supplier. Phase 19 (B), PE6: Admin or Owner;
  // refused (409 FACTORY_SUPPLIER_HAS_HISTORY) while anything records its
  // history — containers (and through them commissions, offload charges, FX
  // allocations), raw stock, raw-material adjustments, mix sources, waste,
  // payments, FX transfers, voucher lines (live or retired voucher), linked
  // child suppliers, or a non-zero opening. An empty supplier is removed in one
  // transaction with its derived score snapshots and one audit row (the row as
  // it was). With every voucher line refused there is no journal left to
  // orphan. Before: sign-in only, it cascaded through containers, raw stock,
  // commissions and payments with no transaction or audit, leaving their
  // journals orphaned.
  app.delete(
    "/api/factory/suppliers/:id/permanent",
    requireAuth,
    requireRole("Admin", "Owner"),
    validateRequest(supplierActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const outcome = await db.transaction(async (tx) => {
          const [supplier] = await tx
            .select()
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
            .for("update");
          if (!supplier) return { status: 404 as const, body: { message: "Supplier not found" } };

          const history = await factorySupplierHistoryCountsTx(tx, companyId, id);
          const opening = toMoney(supplier.openingBalance);
          const blockers = Object.entries(history).filter(([, count]) => count > 0);
          if (blockers.length > 0 || !opening.isZero()) {
            return {
              status: 409 as const,
              body: {
                message: FACTORY_SUPPLIER_HAS_HISTORY_MESSAGE,
                code: FACTORY_SUPPLIER_HAS_HISTORY_CODE,
                history: {
                  ...Object.fromEntries(blockers),
                  ...(opening.isZero() ? {} : { opening: opening.toFixed() }),
                },
              },
            };
          }

          const snapshots = await tx
            .delete(factorySupplierScoreSnapshots)
            .where(
              and(
                eq(factorySupplierScoreSnapshots.companyId, companyId),
                eq(factorySupplierScoreSnapshots.supplierId, id)
              )
            )
            .returning({ id: factorySupplierScoreSnapshots.id });
          await tx
            .delete(factorySuppliers)
            .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)));
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "delete",
              tableName: "factory_suppliers",
              recordId: supplier.id,
              recordIdentifier: supplier.name,
              changes: {
                supplier: { old: supplier },
                scoreSnapshotsRemoved: { new: snapshots.length },
                reason: { new: "permanent delete (no history)" },
              },
            },
            tx
          );
          return { status: 200 as const, body: { message: "Supplier permanently deleted" } };
        });
        res.status(outcome.status).json(outcome.body);
      } catch (error: unknown) {
        logger.error("Error permanently deleting factory supplier:", { error: error });
        res.status(errorStatus(error, 500)).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // 1b. Factory Supplier Categories
  // ───────────────────────────────────────────────
}
