import type { NextFunction, Request, Response } from "express";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";

/** The rental paths must use the active company's current assignment, not a
 * stale session role or the user's permissions in another company.
 * This mirrors the general operational delete policy: Admin/Developer/Owner,
 * or a non-POS user explicitly granted canDeleteRecords.
 */
export function mayDeleteRentalRecords(role: string, canDeleteRecords: boolean): boolean {
  if (role === "Developer" || role === "Admin" || role === "Owner") return true;
  if (role === "POS" || role === "View Only" || role === "Create Only" || role === "ERP Tester") return false;
  return canDeleteRecords;
}

export async function requireRentalDeletePermission(req: Request, res: Response, next: NextFunction) {
  try {
    const context = await getActiveCompanyPermissionContext(req);
    if (!mayDeleteRentalRecords(context.role, context.canDeleteRecords)) {
      return res.status(403).json({ message: "You do not have permission to delete rental payments" });
    }
    next();
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    next(error);
  }
}

/** Read-only reconciliation is restricted to the selected company's Admin or
 * Developer, matching the pre-existing reconciliation contract.
 */
export async function requireRentalReconciliationPermission(req: Request, res: Response, next: NextFunction) {
  try {
    const context = await getActiveCompanyPermissionContext(req);
    if (context.role !== "Admin" && context.role !== "Developer") {
      return res.status(403).json({ message: "Administrator or Developer role required" });
    }
    next();
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    next(error);
  }
}
