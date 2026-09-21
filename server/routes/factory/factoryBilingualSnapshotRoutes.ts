import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireActionAccess } from "../../lib/permissionMiddleware";
import { writeAuditEvent } from "../../services/audit/auditService";
import {
  applyFactoryBilingualSnapshotBackfill,
  applyFactoryBilingualSnapshotBackfillForScope,
  buildFactoryBilingualSnapshotPlan,
  propagateFactoryArabicCatalogChange,
  type FactoryBilingualSnapshotScope,
} from "../../services/factoryBilingualSnapshotService";
import { registerFactoryBilingualDocumentRoutes } from "./factoryBilingualDocumentRoutes";
import { registerFactoryBilingualSurfaceRoutes } from "./factoryBilingualSurfaceRoutes";
import { registerFactoryFrenchCatalogReadRoutes } from "./factoryFrenchCatalogReadRoutes";

function getFactoryCompanyId(req: Request): number | null {
  const companyId = Number(req.session?.factoryCompanyId);
  return Number.isSafeInteger(companyId) && companyId > 0 ? companyId : null;
}

function isAdmin(req: Request): boolean {
  const role = String(req.user?.role ?? req.session?.currentRole ?? "");
  return ["Admin", "Owner", "Developer"].includes(role);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Metadata-only writes do not create or rename product snapshots. Running a
 * full-company snapshot backfill after these requests used to turn a one-row
 * edit (for example loading-note) into dozens of schema probes and UPDATEs.
 */
function isSnapshotNeutralWrite(req: Request): boolean {
  return /^\/customer-orders\/\d+\/(?:loading-note|hidden|date|assign-container)$/.test(req.path);
}

function shouldPopulateAfterWrite(req: Request): boolean {
  if (!["POST", "PATCH", "PUT"].includes(req.method)) return false;
  if (req.path.startsWith("/bilingual-snapshots/")) return false;
  if (req.path.includes("/arabic-import/")) return false;
  if (isSnapshotNeutralWrite(req)) return false;
  return /^\/(bales|bale-products|customer-proformas|customer-orders|customer-orders-loading|invoice-loading|invoice-loading-sessions|dispatch|factory-pos|bale-recode)/.test(
    req.path
  );
}

function scopeFromRequest(req: Request, payload: unknown): FactoryBilingualSnapshotScope | null {
  const responseRecord =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const responseId = positiveId(responseRecord?.id);

  // The compact bale-scan response tells us exactly which two snapshot rows
  // changed. Keep this synchronous post-write work row-scoped instead of
  // replaying every order-linked snapshot target before acknowledging a scan.
  if (/^\/customer-orders\/\d+\/bales$/.test(req.path) && responseRecord?.compactBaleScan === true) {
    const baleRecord =
      responseRecord.bale && typeof responseRecord.bale === "object" && !Array.isArray(responseRecord.bale)
        ? (responseRecord.bale as Record<string, unknown>)
        : null;
    const lineRecord =
      responseRecord.line && typeof responseRecord.line === "object" && !Array.isArray(responseRecord.line)
        ? (responseRecord.line as Record<string, unknown>)
        : null;
    const orderBaleId = positiveId(baleRecord?.id);
    const orderLineId = positiveId(lineRecord?.id);
    if (orderBaleId || orderLineId) {
      return {
        ...(orderBaleId ? { orderBaleId } : {}),
        ...(orderLineId ? { orderLineId } : {}),
      };
    }
  }

  const pathRules: Array<{ pattern: RegExp; key: keyof FactoryBilingualSnapshotScope }> = [
    { pattern: /^\/customer-orders\/(\d+)(?:\/|$)/, key: "orderId" },
    { pattern: /^\/customer-proformas\/(\d+)(?:\/|$)/, key: "proformaId" },
    { pattern: /^\/bales\/(\d+)(?:\/|$)/, key: "baleId" },
    { pattern: /^\/factory-pos\/sales\/(\d+)(?:\/|$)/, key: "posSaleId" },
    { pattern: /^\/invoice-loading(?:-sessions)?\/(\d+)(?:\/|$)/, key: "invoiceLoadingId" },
    { pattern: /^\/dispatch(?:-batches)?\/(\d+)(?:\/|$)/, key: "dispatchBatchId" },
    { pattern: /^\/bale-recode(?:-sessions)?\/(\d+)(?:\/|$)/, key: "recodeSessionId" },
  ];

  for (const rule of pathRules) {
    const match = req.path.match(rule.pattern);
    const id = positiveId(match?.[1]);
    if (id) return { [rule.key]: id } as FactoryBilingualSnapshotScope;
  }

  // Creation endpoints expose the newly-created resource id in their response.
  if (responseId) {
    if (req.path === "/customer-orders" || req.path === "/customer-orders-loading") return { orderId: responseId };
    if (req.path === "/customer-proformas") return { proformaId: responseId };
    if (req.path === "/bales") return { baleId: responseId };
  }

  return null;
}

async function populateAfterSuccessfulWrite(req: Request, payload: unknown): Promise<void> {
  const companyId = getFactoryCompanyId(req);
  if (!companyId) return;

  const productMatch = req.path.match(/^\/bale-products\/(\d+)/);
  if (productMatch) {
    const productId = positiveId(productMatch[1]);
    if (productId) {
      await propagateFactoryArabicCatalogChange(companyId, productId);
      return;
    }
  }

  const scope = scopeFromRequest(req, payload);
  if (scope) {
    await applyFactoryBilingualSnapshotBackfillForScope(companyId, scope);
    return;
  }

  // Preserve legacy behavior for genuinely bulk/ambiguous writes where a single
  // affected entity cannot be identified. Explicit admin backfills also continue
  // to use the full-company path below.
  await applyFactoryBilingualSnapshotBackfill(companyId, {
    includeFinalized: false,
    overwrite: false,
  });
}

function factoryBilingualSnapshotWriteMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!shouldPopulateAfterWrite(req)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    if (res.statusCode < 200 || res.statusCode >= 300) return originalJson(payload);
    void populateAfterSuccessfulWrite(req, payload)
      .then(() => originalJson(payload))
      .catch((error) => {
        logger.error("Failed to populate Factory bilingual snapshots after write", {
          error,
          method: req.method,
          path: req.path,
        });
        if (!res.headersSent) res.status(500);
        originalJson({ message: getErrorMessage(error) });
      });
    return res;
  }) as typeof res.json;
  next();
}

export function registerFactoryBilingualSnapshotRoutes(app: Express): void {
  registerFactoryBilingualDocumentRoutes(app);
  registerFactoryBilingualSurfaceRoutes(app);
  registerFactoryFrenchCatalogReadRoutes(app);
  app.use("/api/factory", factoryBilingualSnapshotWriteMiddleware);

  app.get(
    "/api/factory/bilingual-snapshots/diagnose",
    requireAuth,
    requireActionAccess("act_import_data"),
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(403).json({ message: "Factory company access required" });
        return res.json(await buildFactoryBilingualSnapshotPlan(companyId));
      } catch (error) {
        logger.error("Failed to diagnose Factory bilingual snapshots", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/bilingual-snapshots/backfill",
    requireAuth,
    requireActionAccess("act_import_data"),
    async (req: Request, res: Response) => {
      try {
        if (!isAdmin(req)) {
          return res.status(403).json({ message: "Admin authorization required" });
        }
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(403).json({ message: "Factory company access required" });

        const apply = booleanValue(req.body?.apply);
        const includeFinalized = booleanValue(req.body?.includeFinalized);
        const overwrite = booleanValue(req.body?.overwrite);
        const plan = await buildFactoryBilingualSnapshotPlan(companyId);

        if (!apply) {
          return res.json({ dryRun: true, plan, options: { includeFinalized, overwrite } });
        }
        if (req.body?.confirmation !== "APPLY_ARABIC_SNAPSHOT_BACKFILL") {
          return res.status(400).json({
            message: "Confirmation is required before applying the snapshot backfill",
            requiredConfirmation: "APPLY_ARABIC_SNAPSHOT_BACKFILL",
            plan,
          });
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(7347, ${companyId})`);
          const before = await buildFactoryBilingualSnapshotPlan(
            companyId,
            tx as unknown as Parameters<typeof buildFactoryBilingualSnapshotPlan>[1]
          );
          const applied = await applyFactoryBilingualSnapshotBackfill(
            companyId,
            { includeFinalized, overwrite },
            tx as unknown as Parameters<typeof applyFactoryBilingualSnapshotBackfill>[2]
          );
          const after = await buildFactoryBilingualSnapshotPlan(
            companyId,
            tx as unknown as Parameters<typeof buildFactoryBilingualSnapshotPlan>[1]
          );
          await writeAuditEvent(
            {
              action: "factory_bilingual_snapshot_backfill",
              entityType: "factory_bilingual_snapshot",
              entityId: companyId,
              companyId,
              userId: Number(req.session?.userId) || undefined,
              metadata: { includeFinalized, overwrite, before, applied, after },
            },
            tx
          );
          return { before, applied, after };
        });

        return res.json({ dryRun: false, ...result });
      } catch (error) {
        logger.error("Failed to backfill Factory bilingual snapshots", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
