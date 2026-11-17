import { getErrorMessage } from "../../lib/httpHandlers";
import { firstRow } from "../../lib/queryResult";
import { toFiniteNumber } from "@shared/typeGuards";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { registerCompanySettingsRoutesPart1 } from "./registerCompanySettingsRoutesPart1";
import { registerCompanySettingsRoutesPart2 } from "./registerCompanySettingsRoutesPart2";

export function registerCompanySettingsRoutes(app: Express) {
  registerCompanySettingsRoutesPart1(app);
  registerCompanySettingsRoutesPart2(app);
  registerCompanySettingsRoutesPart3(app);
}

function registerCompanySettingsRoutesPart3(app: Express) {
  app.get("/api/admin/deployment-diagnostics", requireAuth, requireRole("Admin", "Developer"), async (_req, res) => {
    try {
      const VALID_ROLES = `'Developer','Admin','Owner','Manager','POS','Normal User','View Only','ERP Tester'`;
      const OLD_POS_ROLES = `'POS1','POS2','POS3','POS4','POS5','POS6'`;

      const [
        invalidRoleRows,
        posWithoutStation,
        posWithoutLocation,
        posWithoutCash,
        duplicateRoleRows,
        oldUserRoleRows,
        oldPosRoleRows,
        canDeleteCol,
        posStationCol,
      ] = await Promise.all([
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role NOT IN (${VALID_ROLES})`),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NULL`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND assigned_location_id IS NULL`
        ),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'POS' AND cash_account_id IS NULL`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT user_id, company_id, COUNT(*) FROM user_company_roles
             GROUP BY user_id, company_id HAVING COUNT(*) > 1
           ) sub`
        ),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role = 'User'`),
        db.execute(`SELECT COUNT(*)::int AS n FROM user_company_roles WHERE role IN (${OLD_POS_ROLES})`),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM information_schema.columns
           WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`
        ),
        db.execute(
          `SELECT COUNT(*)::int AS n FROM information_schema.columns
           WHERE table_name = 'user_company_roles' AND column_name = 'pos_station'`
        ),
      ]);

      const pick = (result: unknown) => toFiniteNumber(firstRow<{ n: number }>(result)?.n) ?? 0;

      res.json({
        timestamp: new Date().toISOString(),
        schema: {
          can_delete_records_column_exists: pick(canDeleteCol) > 0,
          pos_station_column_exists: pick(posStationCol) > 0,
        },
        roles: {
          invalid_role_count: pick(invalidRoleRows),
          old_user_role_count: pick(oldUserRoleRows),
          old_pos_role_count: pick(oldPosRoleRows),
        },
        pos_users: {
          without_pos_station: pick(posWithoutStation),
          without_assigned_location: pick(posWithoutLocation),
          without_cash_account: pick(posWithoutCash),
        },
        user_company_roles: {
          duplicate_user_company_pairs: pick(duplicateRoleRows),
        },
        health: {
          all_clear:
            pick(invalidRoleRows) === 0 &&
            pick(oldUserRoleRows) === 0 &&
            pick(oldPosRoleRows) === 0 &&
            pick(canDeleteCol) > 0 &&
            pick(posStationCol) > 0,
        },
      });
    } catch (error: unknown) {
      logger.error("[DeploymentDiag] Error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  // The schema is defined only by the numbered migrations (migrations/, applied
  // by scripts/db/migrate.mjs); the server never runs DDL. This former
  // "apply missing migrations" endpoint is kept only to answer clearly.
  app.post(
    "/api/admin/apply-missing-migrations",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    (_req, res) => {
      res.status(410).json({
        success: false,
        // Schema changes are applied only by scripts/db/migrate.mjs (docs/database-migrations.md).
        code: "SCHEMA_MANAGED_BY_MIGRATIONS",
      });
    }
  );
}
