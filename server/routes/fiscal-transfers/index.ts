/**
 * fiscalTransferRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerStockTransferReadRoutes } from "./reads";
import { registerStockTransferCreateRoutes } from "./create";
import { registerStockTransferRevisionReadRoutes } from "./revisions-read";
import { registerPosTransferDetailRoutes } from "./pos-detail";
import { registerStockTransferUpdateRoutes } from "./update";

export function registerFiscalTransferRoutes(app: Express) {
  registerStockTransferReadRoutes(app);
  registerStockTransferCreateRoutes(app);
  registerStockTransferRevisionReadRoutes(app);
  registerPosTransferDetailRoutes(app);
  registerStockTransferUpdateRoutes(app);
}
