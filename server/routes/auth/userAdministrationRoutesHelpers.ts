// Extracted from ./userAdministrationRoutes.ts
import type { Request, Response } from "express";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { CompanyAdministratorGuardError } from "../../services/security/companyAdministratorGuard";
import { recordPermissionSignal } from "../../services/security/permissionMonitor";
import { sql } from "drizzle-orm";

export async function invalidateUserSessions(userId: string) {
  try {
    await db.execute(sql`DELETE FROM session WHERE sess::jsonb ->> 'userId' = ${userId}`);
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
}

/** Answer a refused or failed role assignment and record the monitoring signal. */
export function respondRoleAssignmentFailure(req: Request, res: Response, error: unknown): void {
  const guard = error instanceof CompanyAdministratorGuardError ? error : null;
  recordPermissionSignal({
    kind: "role_assignment_failed",
    code: guard?.code ?? "ROLE_ASSIGNMENT_INVALID",
    companyId: req.session.currentCompanyId ?? null,
    userId: req.session.userId ?? null,
    role: req.session.currentRole ?? null,
    method: req.method,
    path: req.path,
  });
  if (guard) {
    res.status(guard.status).json({ code: guard.code, message: guard.message });
    return;
  }
  res.status(400).json({ message: getErrorMessage(error) });
}
