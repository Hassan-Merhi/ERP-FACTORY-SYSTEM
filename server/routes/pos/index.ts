import { type Express } from "express";
import { requireAuth } from "../../auth";
import { enforcePosOperationalPermissionScope } from "../../middleware/posOperationalPermissionScope";
import { enforcePosCapabilityScope } from "../../middleware/posCapabilityScope";
import { registerPosContainerTrackingRoutes } from "./posContainerTrackingRoutes";
import { registerPosPrintRoutes } from "./posPrintRoutes";
import { registerPosSalesRoutes } from "./posSalesRoutes";
import { registerPosEditSaleRoutes } from "./posEditSaleRoutes";
import { registerPosItemReplacementRoutes } from "./posItemReplacementRoutes";
import { registerPosShiftRoutes } from "./posShiftRoutes";
import { registerPosDraftRoutes } from "./posDraftRoutes";
import { registerPosCustomerRoutes } from "./posCustomerRoutes";
import { registerPosWhatsAppRoutes } from "./posWhatsAppRoutes";

export function registerAllPosRoutes(app: Express): void {
  // Run before all POS handlers. The legacy handlers keep their own requireAuth
  // middleware; these boundaries refresh company-role/POS flags, validate location
  // and cash-account scope, and enforce body-dependent POS capabilities before any
  // business transaction begins.
  app.use("/api/pos", requireAuth, enforcePosOperationalPermissionScope, enforcePosCapabilityScope);
  app.use(/^\/api\/vouchers\/\d+\/sales$/, requireAuth, enforcePosOperationalPermissionScope);

  registerPosContainerTrackingRoutes(app);
  registerPosPrintRoutes(app);
  registerPosSalesRoutes(app);
  registerPosEditSaleRoutes(app);
  registerPosItemReplacementRoutes(app);
  registerPosShiftRoutes(app);
  registerPosDraftRoutes(app);
  registerPosCustomerRoutes(app);
  registerPosWhatsAppRoutes(app);
}
