import type { Express } from "express";
import { requireAuth } from "../../auth";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import {
  handlePostSale,
  handleReadiness,
  PHASE6_READINESS_PATH,
  PHASE6_SALE_PATH,
  phase6RequestBudget,
} from "./spGoldenCoastPosSaleDeductionsRoutes";

export function registerSpGoldenCoastPhase6PosSaleRoutes(app: Express): void {
  app.get(PHASE6_READINESS_PATH, privilegedReadRateLimit, requireAuth, (req, res) => void handleReadiness(req, res));
  app.post(
    PHASE6_SALE_PATH,
    privilegedMutationRateLimit,
    phase6RequestBudget,
    requireAuth,
    (req, res) => void handlePostSale(req, res)
  );
}
