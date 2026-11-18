import type { NextFunction, Request, Response } from "express";
import { canCreatePosCustomers, canViewPosCustomers, posCustomerAccessText } from "@shared/posCustomerAccess";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";

/** Use the live company role for every customer read and write. */
export async function requirePosCustomerPermission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await getActiveCompanyPermissionContext(req);
    const canRead = canViewPosCustomers(context);
    const canWrite = canCreatePosCustomers(context);
    if (!canRead || (req.method !== "GET" && !canWrite)) {
      res.status(403).json({
        code: "POS_CUSTOMERS_ACCESS_DENIED",
        message: !canRead ? posCustomerAccessText.denied : posCustomerAccessText.createDenied,
      });
      return;
    }
    next();
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    next(error);
  }
}
