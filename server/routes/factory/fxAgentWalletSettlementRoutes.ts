import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import { finalizeFxWalletDraft } from "./fxAgentWalletDraftLifecycle";
import { settleWalletInput } from "./fxAgentWalletRouteSchemas";
import { registerFactoryFxAgentSettlementRoutesPart1 } from "./registerFactoryFxAgentSettlementRoutesPart1";

/**
 * Payment out of an agent's EUR balance to a EUR factory supplier, or to a USD beneficiary.
 * The agent's historical USD book basis (not the Settings rate) is credited;
 * the difference from the actual USD payout is a realized FX gain or loss.
 */
export function registerFactoryFxAgentSettlementRoutes(app: Express) {
  const { settleWalletPayment } = registerFactoryFxAgentSettlementRoutesPart1();

  app.post(
    "/api/factory/fx-agent-wallets/:id/settle",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    validateRequest(settleWalletInput),
    settleWalletPayment
  );

  // The Optional Vouchers screen uses the same finalize URL as other drafts.
  // Recognize only EUR FX wallet drafts; let the ordinary handlers own others.
  app.post("/api/vouchers/:id/finalize", requireAuth, (req, res, next) => finalizeFxWalletDraft(req, res, next));
}
