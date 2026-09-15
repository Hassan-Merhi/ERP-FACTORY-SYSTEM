import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import { pool } from "../../db";
import { sendHttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId } from "../../lib/parseId";

async function guardPurchaseOrderEdit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const purchaseOrderId = parseId(req.params.id);
  if (purchaseOrderId === null || !Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
    res.status(400).json({ message: "Invalid purchase order ID" });
    return;
  }

  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  const client = await pool.connect();
  let released = false;
  let containerId: number | null = null;

  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (containerId) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [companyId, containerId]);
      }
    } catch (error) {
      logger.warn("Purchase-order edit advisory unlock failed", {
        companyId,
        purchaseOrderId,
        containerId,
        error,
      });
    } finally {
      client.release();
    }
  };

  try {
    const purchaseOrder = await client.query<{ container_id: number | null }>(
      `SELECT container_id
       FROM purchase_orders
       WHERE id = $1 AND company_id = $2
       LIMIT 1`,
      [purchaseOrderId, companyId]
    );
    if (!purchaseOrder.rows[0]) {
      client.release();
      released = true;
      res.status(404).json({ message: "Purchase order not found" });
      return;
    }

    containerId = Number(purchaseOrder.rows[0].container_id);
    if (!Number.isInteger(containerId) || containerId <= 0) {
      client.release();
      released = true;
      res.status(409).json({
        code: "PURCHASE_ORDER_CONTAINER_REQUIRED",
        message: "Purchase order is not linked to a valid container.",
      });
      return;
    }

    const lockResult = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [
      companyId,
      containerId,
    ]);
    if (!lockResult.rows[0]?.locked) {
      client.release();
      released = true;
      res.status(409).json({
        code: "CONTAINER_WRITE_IN_PROGRESS",
        message: "This container is currently being offloaded or edited. Wait for the first request to finish.",
      });
      return;
    }

    // Re-read after acquiring the shared container lifecycle lock. If the PO was
    // moved or removed between the lookup and lock acquisition, do not let the
    // request continue under a lock for the wrong aggregate.
    const authoritative = await client.query<{ container_id: number | null }>(
      `SELECT container_id
       FROM purchase_orders
       WHERE id = $1 AND company_id = $2
       LIMIT 1`,
      [purchaseOrderId, companyId]
    );
    if (!authoritative.rows[0] || Number(authoritative.rows[0].container_id) !== containerId) {
      await release();
      res.status(409).json({
        code: "PURCHASE_ORDER_STALE",
        message: "Purchase order changed while the edit was starting. Reload it and try again.",
      });
      return;
    }

    res.once("finish", () => void release());
    res.once("close", () => void release());
    next();
  } catch (error: unknown) {
    await release();
    logger.error("Purchase-order edit concurrency guard failed", {
      companyId,
      purchaseOrderId,
      containerId,
      error,
    });
    sendHttpError(res, error);
  }
}

type MutableRouteHandlerLayer = {
  name?: string;
  method?: string;
  handle?: RequestHandler;
};

type MutableRouteLayer = {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
    stack?: MutableRouteHandlerLayer[];
  };
};

/**
 * Wrap the already-registered purchase-order PATCH handler in place.
 *
 * The route-manifest is a production safety contract in this repository: adding
 * a second Express route solely as middleware would change route count/order and
 * make a behavior-preserving concurrency guard look like a routing change. By
 * decorating the existing final handler after registration we keep the exact
 * public route/guard snapshot while holding the container lifecycle advisory
 * lock for the complete original PATCH request.
 */
export function installPurchaseOrderEditConcurrencyGuard(app: Express): void {
  const expressApp = app as unknown as {
    router?: { stack?: MutableRouteLayer[] };
    _router?: { stack?: MutableRouteLayer[] };
  };
  const stack = expressApp.router?.stack ?? expressApp._router?.stack;
  const routeLayer = stack?.find(
    (layer) => layer.route?.path === "/api/purchase-orders/:id" && layer.route.methods?.patch === true
  );
  const handlerLayers = routeLayer?.route?.stack ?? [];
  const originalLayer = [...handlerLayers]
    .reverse()
    .find((layer) => layer.method?.toLowerCase() === "patch" && typeof layer.handle === "function");
  const originalHandle = originalLayer?.handle;

  if (!originalLayer || !originalHandle) {
    throw new Error("Unable to install purchase-order concurrency guard: PATCH handler was not registered");
  }

  const originalHandleName = originalHandle.name;
  const wrappedHandle: RequestHandler = (req, res, next) => {
    void guardPurchaseOrderEdit(req, res, (guardError?: unknown) => {
      if (guardError) {
        next(guardError);
        return;
      }

      try {
        Promise.resolve(originalHandle(req, res, next)).catch(next);
      } catch (error) {
        next(error);
      }
    });
  };

  // Route-manifest extraction falls back to handle.name when the Express layer
  // itself has no name. Preserve the original function name so this safety-only
  // wrapper cannot create a false route-manifest diff.
  try {
    Object.defineProperty(wrappedHandle, "name", {
      value: originalHandleName,
      configurable: true,
    });
  } catch {
    // Function names are normally configurable; the Express layer name remains
    // unchanged even if a runtime forbids redefining this optional metadata.
  }

  originalLayer.handle = wrappedHandle;
}
