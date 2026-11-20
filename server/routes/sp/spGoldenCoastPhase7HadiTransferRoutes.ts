import type { Express } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import {
  GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
  goldenCoastPhase16LegacyHadiRetiredPayload,
  phase16RequestBudget,
} from "./goldenCoastPhase16LegacyHadiRetiredPayload";
import { handleReadiness } from "./spGoldenCoastPhase7HadiTransferRoutesHandleReadiness";

export function registerSpGoldenCoastPhase7HadiTransferRoutes(app: Express): void {
  // HADI discovery still reads the Phase 7 readiness probe.
  app.get(
    "/api/sp/golden-coast/phase7/sales-cash-transfer/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );
  // Route declaration only. registerSpGoldenCoastPhase16HadiTransferGuard,
  // mounted before this, answers every POST to this path (409 retired, or the
  // Phase 16 remit_from_hadi handler), so the end of this chain never runs.
  // The registration stays because the access boundary serves only routes
  // declared in config/route-access-manifest.json: without it the live
  // Phase 16 remittance would be refused as an unknown route (404).
  app.post(
    GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
    privilegedMutationRateLimit,
    phase16RequestBudget,
    requireAuth,
    requireNonPOS,
    (_req, res) => void res.status(409).json(goldenCoastPhase16LegacyHadiRetiredPayload())
  );
}
