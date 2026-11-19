import { Request, Response, NextFunction } from "express";
import { logDenied } from "./authDenialLog";
import { getClientDate, getTrustedClientDate } from "./lib/dateUtils";
import {
  isOwnerProtectedDeleteRequest,
  rejectInvalidSession,
  enforceCredentialAwareSession,
  authorizeExplicitCompanyScope,
  REQUIRED_ROLES_METADATA,
} from "./authHelpers";
export { REQUIRED_ROLES_METADATA, checkPOSLocation } from "./authHelpers";

export async function requireLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await enforceCredentialAwareSession(req, {
      requireCompanyContext: false,
    });
    if (!result.valid) {
      return rejectInvalidSession(req, res, result, "Unauthorized");
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionResult = await enforceCredentialAwareSession(req, {
      requireCompanyContext: true,
    });
    if (!sessionResult.valid) {
      const message = sessionResult.code === "SESSION_COMPANY_REQUIRED" ? "No company selected" : "Unauthorized";
      return rejectInvalidSession(req, res, sessionResult, message);
    }

    const role = req.session.currentRole;
    if (!role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Owners may delete normal operational records (including bales), but
    // voucher and account deletion remains protected centrally.
    if (role === "Owner" && isOwnerProtectedDeleteRequest(req.method, req.path)) {
      logDenied({
        userId: req.session.userId ?? null,
        username: req.session.username ?? null,
        role,
        companyId: req.session.currentCompanyId ?? null,
        method: req.method,
        path: req.path,
        reason: "Owner role cannot delete vouchers or accounts",
      });
      return res.status(403).json({ message: "Owners cannot delete vouchers or accounts" });
    }

    if (!authorizeExplicitCompanyScope(req, res)) return;

    req.user = {
      id: req.session.userId,
      username: req.session.username,
      role,
      assignedLocationId: req.session.currentLocationId ?? null,
      posStation: req.session.currentPOSStation ?? null,
      cashAccountId: req.session.cashAccountId ?? null,
      canSellNegativeStock: ["Admin", "Owner", "Manager", "Developer"].includes(role)
        ? true
        : (req.session.canSellNegativeStock ?? false),
      posViewOnly: req.session.posViewOnly ?? false,
      daybookEditDays: req.session.daybookEditDays ?? 0,
      canAccessCustomers: req.session.canAccessCustomers ?? false,
      canDeleteRecords: req.session.canDeleteRecords ?? false,
    } as unknown as {
      id: string | undefined;
      username: string | undefined;
      role: string;
      assignedLocationId: number | null;
      posStation: number | null;
      cashAccountId: number | null;
      canSellNegativeStock: boolean;
      posViewOnly: boolean;
      daybookEditDays: number;
      canAccessCustomers: boolean;
      canDeleteRecords: boolean;
    } & (
      | ({
          id: string;
          active: boolean;
          createdAt: Date;
          username: string;
          password: string;
          chatbotEnabled: boolean;
          hiddenErpCostFields: string[];
        } & {
          role?: string;
          assignedLocationId?: number | null;
          posStation?: number | null;
          cashAccountId?: number | null;
          canSellNegativeStock?: boolean;
          daybookEditDays?: number;
          canAccessCustomers?: boolean;
        })
      | undefined
    );

    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: string[]) {
  // The handler is deliberately an anonymous arrow: its name is part of the
  // route snapshot (config/route-manifest.json), which must not change. The
  // role list is attached so config/route-access-manifest.json can declare it
  // and tests/route-access-manifest.test.ts can verify the declaration.
  return Object.assign(
    async (req: Request, res: Response, next: NextFunction) => {
      if (!req.user || !req.user.role) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      // ERP Tester can exercise Manager-level operational routes, but never Admin/Owner/Developer routes.
      // Settings and administrative APIs are independently blocked by blockErpTesterSettings.
      if (
        req.user.role === "Developer" ||
        roles.includes(req.user.role) ||
        (req.user.role === "ERP Tester" && roles.includes("Manager"))
      ) {
        return next();
      }

      return res.status(403).json({ message: "Forbidden" });
    },
    { [REQUIRED_ROLES_METADATA]: Object.freeze([...roles]) as readonly string[] }
  );
}

export function canDelete(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const role = req.user.role;
  const path = req.path;
  const method = req.method;
  const userId = req.session.userId ?? null;
  const username = req.session.username ?? null;
  const companyId = req.session.currentCompanyId ?? null;

  if (role === "Developer" || role === "Admin") {
    return next();
  }

  if (role === "Owner") {
    if (isOwnerProtectedDeleteRequest(method, path)) {
      logDenied({
        userId,
        username,
        role,
        companyId,
        method,
        path,
        reason: "Owner role cannot delete vouchers or accounts",
      });
      return res.status(403).json({ message: "Owners cannot delete vouchers or accounts" });
    }
    return next();
  }

  if (role === "POS") {
    logDenied({ userId, username, role, companyId, method, path, reason: "POS role cannot delete records" });
    return res.status(403).json({ message: "POS users cannot delete records" });
  }

  if (req.session.canDeleteRecords === true) {
    return next();
  }

  if (role === "Manager") {
    logDenied({ userId, username, role, companyId, method, path, reason: "Manager without canDeleteRecords flag" });
    return res.status(403).json({ message: "This manager account does not have delete permission" });
  }

  logDenied({
    userId,
    username,
    role,
    companyId,
    method,
    path,
    reason: `Role '${role}' is not permitted to delete records`,
  });
  return res.status(403).json({ message: "You do not have permission to delete records" });
}

export function canModifyDate(dateField: string = "voucherDate") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const role = req.user.role;
    if (role === "Admin" || role === "Developer") return next();

    const recordDate: string | undefined = req.body[dateField];
    if (!recordDate) return next();

    // Create Only never backdates or postdates, and cannot widen "today" with a
    // forged X-Client-Date header.
    if (role === "Create Only") {
      if (recordDate !== getTrustedClientDate(req)) {
        return res.status(403).json({ message: "You can only create records for today's date" });
      }
      return next();
    }

    const today = getClientDate(req);
    if (role === "POS") {
      if (recordDate !== today) {
        return res.status(403).json({ message: "You can only create or modify records for today's date" });
      }
      return next();
    }

    if (role === "Manager" || role === "Owner" || role === "ERP Tester") {
      if (recordDate === today) return next();
      const editDays = req.session.daybookEditDays ?? 0;
      if (editDays === 0) {
        return res.status(403).json({ message: "You can only create or modify records for today's date" });
      }
      const todayMs = new Date(today).getTime();
      const recordMs = new Date(recordDate).getTime();
      const diffDays = Math.floor((todayMs - recordMs) / 86_400_000);
      if (diffDays < 0 || diffDays > editDays) {
        return res.status(403).json({ message: `You can only modify records within ${editDays} day(s) of today` });
      }
      return next();
    }

    next();
  };
}

export async function requirePasswordConfirmation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await enforceCredentialAwareSession(req, {
      requireCompanyContext: true,
      requireRecentPasswordConfirmation: true,
    });
    if (!result.valid) {
      const message =
        result.code === "SESSION_PASSWORD_CONFIRMATION_REQUIRED" ? "Password confirmation required" : "Unauthorized";
      return rejectInvalidSession(req, res, result, message);
    }
    next();
  } catch (error) {
    next(error);
  }
}

export {
  blockErpTesterSettings,
  blockViewOnlyWrites,
  blockUnverifiedCreateOnlyWrites,
  requireNonPOS,
} from "./authWriteGuards";
