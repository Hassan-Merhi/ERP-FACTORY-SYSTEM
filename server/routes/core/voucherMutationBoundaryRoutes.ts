import type { Express } from "express";

import { registerProductionBonusVoucherBoundary } from "../../middleware/productionBonusVoucherBoundary";
import { registerProtectedCorrectionMutationBoundary } from "../../middleware/protectedCorrectionMutation";
import { registerRetailManualVoucherBoundary } from "../../middleware/retailManualVoucherBoundary";

/**
 * Business invariants that must run before every voucher writer. These are not
 * access rules: module, action and export permissions are declared per route
 * in config/route-access-manifest.json and enforced by the access boundary.
 */
export function registerVoucherMutationBoundaries(app: Express): void {
  registerProtectedCorrectionMutationBoundary(app);
  // Production bonus vouchers are corrected from the Production Bonus page only,
  // so the bonus record and the books cannot drift apart.
  registerProductionBonusVoucherBoundary(app);
  // Retail companies cannot manually create/edit Journal, Credit/Debit Note,
  // Adjustment or Transfer Order vouchers; this runs before every voucher writer.
  registerRetailManualVoucherBoundary(app);
}
