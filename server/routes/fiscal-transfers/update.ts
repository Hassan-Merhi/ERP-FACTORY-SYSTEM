/**
 * fiscalTransferRoutes: StockTransferUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { registerStockAdjustmentWasteRoutes } from "../stockAdjustmentWasteRoutes";

export function registerStockTransferUpdateRoutes(app: Express) {
  // PUT /api/stock-transfers/:id is served by registerStockTransferLifecycleRoutes
  // (registered earlier, so it always matched first). The copy that used to be
  // here looked the transfer up by id alone and never checked its company or
  // locations; it was unreachable and is removed so a route-order change
  // cannot bring it back.
  registerStockAdjustmentWasteRoutes(app);
}
