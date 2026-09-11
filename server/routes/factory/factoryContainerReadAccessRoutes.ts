import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  containerDocuments,
  containerDocumentTypes,
  containerFreight,
  containerFreightPayments,
  containers,
} from "@shared/schema";

/**
 * These endpoints live below /api/factory for historical reasons but are used by
 * the ERP ContainerDetail screen and their tables reference the ERP `containers`
 * table. Prefer the actively selected ERP company; factoryCompanyId can remain
 * populated from a previous factory-mode session and must not override it here.
 */
function resolveErpContainerCompanyId(req: import("express").Request): number | null {
  const raw = req.session?.currentCompanyId || req.session?.factoryCompanyId;
  const companyId = Number(raw);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function parsePositiveId(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function ownsErpContainer(containerId: number, companyId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: containers.id })
    .from(containers)
    .where(and(eq(containers.id, containerId), eq(containers.companyId, companyId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Registers corrected ERP-container document/freight reads before the legacy
 * docs module. The legacy handlers choose factoryCompanyId first, producing 403
 * responses when an ERP user has a stale factory company stored in the session.
 */
export function registerFactoryContainerReadAccessRoutes(app: Express) {
  app.get("/api/factory/containers/:containerId/documents", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = resolveErpContainerCompanyId(req);
      const containerId = parsePositiveId(req.params.containerId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!containerId) return res.status(400).json({ message: "Invalid container ID" });
      if (!(await ownsErpContainer(containerId, companyId))) {
        return res.status(403).json({ message: "Access denied" });
      }

      const rawDocs = await db
        .select()
        .from(containerDocuments)
        .where(and(eq(containerDocuments.containerId, containerId), eq(containerDocuments.companyId, companyId)));
      const docTypes = await db.select().from(containerDocumentTypes).orderBy(containerDocumentTypes.label);
      const requiredTypes = docTypes.filter(
        (docType) => docType.isRequired && (docType.companyId == null || docType.companyId === companyId)
      );
      const uploadedTypeIds = new Set(rawDocs.map((doc) => doc.docTypeId));

      const documents = rawDocs.map((doc) => ({
        ...doc,
        fileData: undefined,
        isGhost: !doc.storageKey && !doc.fileData,
      }));

      return res.json({
        documents,
        docTypes: docTypes.filter((docType) => docType.companyId == null || docType.companyId === companyId),
        completeness: {
          total: requiredTypes.length,
          uploaded: requiredTypes.filter((docType) => uploadedTypeIds.has(docType.id)).length,
          complete: requiredTypes.every((docType) => uploadedTypeIds.has(docType.id)),
        },
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/containers/:containerId/freight", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = resolveErpContainerCompanyId(req);
      const containerId = parsePositiveId(req.params.containerId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!containerId) return res.status(400).json({ message: "Invalid container ID" });
      if (!(await ownsErpContainer(containerId, companyId))) {
        return res.status(403).json({ message: "Access denied" });
      }

      const freightRows = await db
        .select()
        .from(containerFreight)
        .where(and(eq(containerFreight.containerId, containerId), eq(containerFreight.companyId, companyId)));

      if (freightRows.length === 0) return res.json([]);

      const freightIds = freightRows.map((row) => row.id);
      const payments = await db
        .select()
        .from(containerFreightPayments)
        .where(
          and(
            eq(containerFreightPayments.companyId, companyId),
            inArray(containerFreightPayments.containerFreightId, freightIds)
          )
        );

      const paymentsByFreight = new Map<number, (typeof payments)[number][]>();
      for (const payment of payments) {
        const existing = paymentsByFreight.get(payment.containerFreightId) ?? [];
        existing.push(payment);
        paymentsByFreight.set(payment.containerFreightId, existing);
      }

      return res.json(
        freightRows.map((freight) => {
          const freightPayments = paymentsByFreight.get(freight.id) ?? [];
          const totalPaid = freightPayments.reduce((sum, payment) => sum + Number(payment.amount), 0);
          const freightAmount = Number(freight.freightAmount);
          const computedStatus = totalPaid >= freightAmount ? "PAID" : totalPaid > 0 ? "PARTIAL" : "UNPAID";
          return { ...freight, payments: freightPayments, totalPaid, computedStatus };
        })
      );
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
