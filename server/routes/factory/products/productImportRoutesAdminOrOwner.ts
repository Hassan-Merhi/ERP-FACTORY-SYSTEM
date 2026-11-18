// Extracted from ./productImportRoutes.ts to keep that module under the source-size cap.
import { requireRole } from "../../../auth";

/** Phase 19 C (F7/DI10): the bale Excel import is Admin/Owner (Developer passes). */
export const adminOrOwner = requireRole("Admin", "Owner");
