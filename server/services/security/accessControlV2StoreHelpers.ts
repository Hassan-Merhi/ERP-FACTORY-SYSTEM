// Extracted from ./accessControlV2Store.ts
import { pool } from "../../db";
import type { PoolClient } from "pg";
import {
  CREATE_ONLY_ROLE,
  evaluateAccessControl,
  type AccessControlAction,
  type AccessControlResource,
  type AccessDecision,
} from "@shared/accessControlV2";
import { canAccessModule } from "../../lib/permissionHelpers";

export interface V2RuleChange {
  resource: AccessControlResource;
  action: AccessControlAction;
  decision: AccessDecision;
}

export type PermissionSubject = { kind: "role"; roleKey: string } | { kind: "user"; userId: string };

interface RuleRow {
  resource_key: string;
  action_key: string;
  decision: AccessDecision;
}

export interface VersionRow {
  revision: string;
  mode: string;
}

export interface V2PolicyActor {
  companyId: number;
  userId: string;
}

export const reserved = new Set(["system.users", "system.settings", "system.maintenance"]);

export const immutableActions = new Set(["manage_settings", "manage_users", "repair"]);

export type V2Queryable = Pick<PoolClient, "query">;

/**
 * Run several policy reads against one consistent database snapshot. Rules and
 * the revision an editor later sends back as expectedRevision must describe the
 * same committed state, or a save based on stale rules could pass the revision
 * check and silently overwrite a concurrent administrator's change.
 */
export async function withV2Snapshot<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await read(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Membership directory for the shadow User Access editor.
 * User IDs and assigned roles come only from canonical company membership.
 * Do not expose credentials, email addresses, financial data, or other companies.
 */
export async function readV2CompanyMembers(companyId: number) {
  const result = await pool.query<{ userId: string; role: string }>(
    `SELECT user_id AS "userId", role FROM user_company_roles
      WHERE company_id=$1 ORDER BY user_id LIMIT 2000`,
    [companyId]
  );
  return result.rows;
}

export async function readOverridesWith(db: V2Queryable, companyId: number, userId: string) {
  const result = await db.query(
    `SELECT resource_key AS "resource", action_key AS "action", decision
       FROM access_user_overrides
      WHERE company_id=$1 AND user_id=$2 ORDER BY resource_key, action_key`,
    [companyId, userId]
  );
  return result.rows;
}

export async function readV2Overrides(companyId: number, userId: string) {
  return readOverridesWith(pool, companyId, userId);
}

export async function loadRules(client: PoolClient, companyId: number, subject: PermissionSubject): Promise<RuleRow[]> {
  if (subject.kind === "role") {
    const result = await client.query<RuleRow>(
      `SELECT r.resource_key, r.action_key, r.decision
         FROM access_role_rules r JOIN access_role_templates t ON t.id=r.role_id AND t.company_id=r.company_id
        WHERE r.company_id=$1 AND t.role_key=$2 ORDER BY r.resource_key, r.action_key`,
      [companyId, subject.roleKey]
    );
    return result.rows;
  }
  const result = await client.query<RuleRow>(
    `SELECT resource_key, action_key, decision FROM access_user_overrides
      WHERE company_id=$1 AND user_id=$2 ORDER BY resource_key, action_key`,
    [companyId, subject.userId]
  );
  return result.rows;
}

/** Shadow-only diagnostic, never a current-access authorization response. */
export async function previewV2(input: {
  companyId: number;
  role: string;
  userId?: string;
  resource: AccessControlResource;
  action: AccessControlAction;
}) {
  const { companyId, role, userId, resource, action } = input;
  const [r, u, legacyRows] = await Promise.all([
    pool.query<{ decision: AccessDecision }>(
      `SELECT r.decision FROM access_role_rules r
       JOIN access_role_templates t ON t.id=r.role_id AND t.company_id=r.company_id
       WHERE r.company_id=$1 AND t.role_key=$2 AND r.resource_key=$3 AND r.action_key=$4`,
      [companyId, role, resource, action]
    ),
    userId
      ? pool.query<{ decision: AccessDecision }>(
          `SELECT decision FROM access_user_overrides
            WHERE company_id=$1 AND user_id=$2 AND resource_key=$3 AND action_key=$4`,
          [companyId, userId, resource, action]
        )
      : Promise.resolve({ rows: [] as Array<{ decision: AccessDecision }> }),
    pool.query<{ feature_key: string; enabled: boolean }>(
      "SELECT feature_key,enabled FROM role_feature_permissions WHERE company_id=$1 AND role=$2",
      [companyId, role]
    ),
  ]);

  const module = resource.startsWith("factory.")
    ? "mod_factory"
    : resource.startsWith("retail.")
      ? "mod_pos"
      : resource.startsWith("properties.")
        ? "mod_properties"
        : resource.startsWith("system.")
          ? "mod_settings"
          : ["erp.accounts", "erp.vouchers"].includes(resource)
            ? "mod_accounting"
            : resource === "erp.analytics"
              ? "mod_analytics"
              : ["erp.stock_items", "erp.stock_transfers", "erp.inventory", "erp.containers"].includes(resource)
                ? "mod_inventory"
                : "mod_erp";

  const legacyModuleAllowed =
    role === CREATE_ONLY_ROLE
      ? null
      : canAccessModule(role, module, new Map(legacyRows.rows.map((x) => [x.feature_key, x.enabled])));

  const evaluationInput = {
    role,
    companyId,
    isAssignedToCompany: true,
    resource,
    action,
    roleDecision: r.rows[0]?.decision,
    userDecision: u.rows[0]?.decision,
    legacyAllowed: legacyModuleAllowed ?? undefined,
  };
  const unverified = evaluateAccessControl({ ...evaluationInput, routeVerified: false });
  const hypothetical = evaluateAccessControl({ ...evaluationInput, routeVerified: true });
  return {
    companyId,
    role,
    userId: userId ?? null,
    resource,
    action,
    roleDecision: r.rows[0]?.decision ?? "inherit",
    userDecision: u.rows[0]?.decision ?? "inherit",
    legacyModuleAllowed,
    legacyModuleOnly: true, // route, page, field and domain hard guards NOT covered
    routeVerified: false,
    currentlyEnforcedByV2: false,
    shadowUnverified: unverified,
    hypotheticalIfHandlerVerified: hypothetical,
  };
}
