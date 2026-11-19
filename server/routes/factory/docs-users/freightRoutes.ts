/**
 * factoryDocsUsersRoutes: FactoryFreight endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import { writeDaybookEntry } from "../_helpers";
import { containerFreight, containerFreightPayments } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getFreightContainerId, verifyContainerOwnership } from "./_helpers";

// Every field is optional: the handler falls back to a default for each one.
const addFreightInput = {
  params: z.strictObject({ containerId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    vendorName: z.string().nullable().optional(),
    vendorSupplierId: z.union([z.number(), z.string()]).nullable().optional(),
    freightAmount: z.union([z.string(), z.number()]).nullable().optional(),
    currency: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    txDate: z.string().optional(),
  }),
} satisfies RequestSchemas;

const deleteFreightInput = {
  params: z.strictObject({ containerId: stringParam, freightId: stringParam }),
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ txDate: z.string().optional() })]),
} satisfies RequestSchemas;

const addFreightPaymentInput = {
  params: z.strictObject({ freightId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    paymentDate: z.string(),
    amount: z.union([z.string(), z.number()]),
    method: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

const deleteFreightPaymentInput = {
  params: z.strictObject({ freightId: stringParam, paymentId: stringParam }),
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ txDate: z.string().optional() })]),
} satisfies RequestSchemas;

export function registerFactoryFreightRoutes(app: Express) {
  // ─────── CONTAINER FREIGHT ───────

  // This GET endpoint is owned by an earlier canonical route registrar.

  app.post(
    "/api/factory/containers/:containerId/freight",
    requireAuth,
    validateRequest(addFreightInput),
    async (req: Request, res: Response) => {
      try {
        const containerId = Number(req.params.containerId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        if (!(await verifyContainerOwnership(containerId, companyId))) {
          return res.status(403).json({ message: "Access denied" });
        }

        const [row] = await db
          .insert(containerFreight)
          .values({
            companyId,
            containerId,
            vendorName: req.body.vendorName || null,
            vendorSupplierId: req.body.vendorSupplierId || null,
            freightAmount: String(req.body.freightAmount || 0),
            currency: req.body.currency || "USD",
            dueDate: req.body.dueDate || null,
            status: "UNPAID",
            notes: req.body.notes || null,
          })
          .returning();

        await writeDaybookEntry(db, {
          companyId,
          txDate: req.body.txDate || getClientDate(req),
          txType: "FREIGHT_ADD",
          referenceId: containerId,
          referenceTable: "containers",
          description: `Added freight charge ${row.currency} ${row.freightAmount} for container #${containerId}${row.vendorName ? ` (${row.vendorName})` : ""}`,
          currencyCode: row.currency,
          amountCurrency: Number(row.freightAmount),
          metaJson: JSON.stringify({ freightId: row.id, vendorName: row.vendorName }),
          createdBy: req.session.userId || undefined,
        });

        res.json(row);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/containers/:containerId/freight/:freightId",
    requireAuth,
    validateRequest(deleteFreightInput),
    async (req: Request, res: Response) => {
      try {
        const freightId = Number(req.params.freightId);
        const containerId = Number(req.params.containerId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;

        if (!companyId || !(await verifyContainerOwnership(containerId, companyId))) {
          return res.status(403).json({ message: "Access denied" });
        }

        await db.delete(containerFreightPayments).where(eq(containerFreightPayments.containerFreightId, freightId));
        const [deleted] = await db
          .delete(containerFreight)
          .where(
            and(
              eq(containerFreight.id, freightId),
              eq(containerFreight.containerId, containerId),
              eq(containerFreight.companyId, companyId)
            )
          )
          .returning();
        if (!deleted) return res.status(404).json({ message: "Freight not found" });

        await writeDaybookEntry(db, {
          companyId: companyId || deleted.companyId,
          txDate: req.body?.txDate || getClientDate(req),
          txType: "FREIGHT_DELETE",
          referenceId: containerId,
          referenceTable: "containers",
          description: `Deleted freight charge ${deleted.currency} ${deleted.freightAmount} from container #${containerId}`,
          currencyCode: deleted.currency,
          amountCurrency: Number(deleted.freightAmount),
          createdBy: req.session.userId || undefined,
        });

        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ─────── FREIGHT PAYMENTS ───────

  app.post(
    "/api/factory/freight/:freightId/payments",
    requireAuth,
    validateRequest(addFreightPaymentInput),
    async (req: Request, res: Response) => {
      try {
        const freightId = Number(req.params.freightId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        // Verify the freight belongs to this company (via its container)
        const freightContainerId = await getFreightContainerId(freightId, companyId);
        if (freightContainerId === null) return res.status(403).json({ message: "Access denied" });

        const [payment] = await db
          .insert(containerFreightPayments)
          .values({
            companyId,
            containerFreightId: freightId,
            paymentDate: req.body.paymentDate,
            amount: String(req.body.amount),
            method: req.body.method || null,
            reference: req.body.reference || null,
            createdBy: req.session.userId ?? null,
          })
          .returning();

        const [fr] = await db.select().from(containerFreight).where(eq(containerFreight.id, freightId));
        const payments = await db
          .select()
          .from(containerFreightPayments)
          .where(eq(containerFreightPayments.containerFreightId, freightId));
        const totalPaid = payments.reduce((sum: number, p) => sum + Number(p.amount), 0);
        const freightAmount = Number(fr.freightAmount);
        const newStatus = totalPaid >= freightAmount ? "PAID" : totalPaid > 0 ? "PARTIAL" : "UNPAID";
        await db
          .update(containerFreight)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(containerFreight.id, freightId));

        await writeDaybookEntry(db, {
          companyId,
          txDate: req.body.paymentDate || getClientDate(req),
          txType: "FREIGHT_PAYMENT",
          referenceId: fr.containerId,
          referenceTable: "containers",
          description: `Freight payment ${fr.currency} ${req.body.amount} for container #${fr.containerId}${fr.vendorName ? ` (${fr.vendorName})` : ""}`,
          currencyCode: fr.currency,
          amountCurrency: Number(req.body.amount),
          metaJson: JSON.stringify({ freightId, paymentId: payment.id }),
          createdBy: req.session.userId || undefined,
        });

        res.json(payment);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/freight/:freightId/payments/:paymentId",
    requireAuth,
    validateRequest(deleteFreightPaymentInput),
    async (req: Request, res: Response) => {
      try {
        const freightId = Number(req.params.freightId);
        const paymentId = Number(req.params.paymentId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;

        // Verify the freight belongs to this company
        if (!companyId || (await getFreightContainerId(freightId, companyId)) === null) {
          return res.status(403).json({ message: "Access denied" });
        }

        const [deleted] = await db
          .delete(containerFreightPayments)
          .where(
            and(
              eq(containerFreightPayments.id, paymentId),
              eq(containerFreightPayments.containerFreightId, freightId),
              eq(containerFreightPayments.companyId, companyId)
            )
          )
          .returning();
        if (!deleted) return res.status(404).json({ message: "Payment not found" });

        const [fr] = await db.select().from(containerFreight).where(eq(containerFreight.id, freightId));
        if (fr) {
          const payments = await db
            .select()
            .from(containerFreightPayments)
            .where(eq(containerFreightPayments.containerFreightId, freightId));
          const totalPaid = payments.reduce((sum: number, p) => sum + Number(p.amount), 0);
          const freightAmount = Number(fr.freightAmount);
          const newStatus = totalPaid >= freightAmount ? "PAID" : totalPaid > 0 ? "PARTIAL" : "UNPAID";
          await db
            .update(containerFreight)
            .set({ status: newStatus, updatedAt: new Date() })
            .where(eq(containerFreight.id, freightId));
        }

        await writeDaybookEntry(db, {
          companyId: companyId || deleted.companyId,
          txDate: req.body?.txDate || getClientDate(req),
          txType: "FREIGHT_PAYMENT_DELETE",
          referenceId: fr?.containerId,
          referenceTable: "containers",
          description: `Deleted freight payment of ${deleted.amount} for freight #${freightId}`,
          amountCurrency: Number(deleted.amount),
          createdBy: req.session.userId || undefined,
        });

        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ─────── BATCH OTW FREIGHT STATUS ───────

  app.get("/api/factory/containers/freight-status", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.json({});
      const allFreight = await db.select().from(containerFreight).where(eq(containerFreight.companyId, companyId));
      const freightIds = allFreight.map((f) => f.id);
      let allPayments: (typeof containerFreightPayments.$inferSelect)[] = [];
      if (freightIds.length > 0) {
        allPayments = await db
          .select()
          .from(containerFreightPayments)
          .where(inArray(containerFreightPayments.containerFreightId, freightIds));
      }
      const paymentsByFreight = new Map<number, number>();
      for (const p of allPayments) {
        paymentsByFreight.set(
          p.containerFreightId,
          (paymentsByFreight.get(p.containerFreightId) || 0) + Number(p.amount)
        );
      }

      const statusByContainer: Record<number, { totalFreight: number; totalPaid: number; status: string }> = {};
      for (const fr of allFreight) {
        const cid = fr.containerId;
        if (!statusByContainer[cid]) statusByContainer[cid] = { totalFreight: 0, totalPaid: 0, status: "NONE" };
        statusByContainer[cid].totalFreight += Number(fr.freightAmount);
        statusByContainer[cid].totalPaid += paymentsByFreight.get(fr.id) || 0;
      }
      for (const cid of Object.keys(statusByContainer)) {
        const s = statusByContainer[Number(cid)];
        s.status =
          s.totalFreight === 0
            ? "NONE"
            : s.totalPaid >= s.totalFreight
              ? "PAID"
              : s.totalPaid > 0
                ? "PARTIAL"
                : "UNPAID";
      }
      res.json(statusByContainer);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
