/**
 * Permissions Control Center V2 — company-scoped SHADOW policy storage.
 * Neither writes to the legacy role tables nor activates new authorization.
 * SQL migration is explicitly applied later; missing schema fails closed.
 */
import { pool } from "../../db";
import type { PoolClient } from "pg";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  CREATE_ONLY_ROLE,
  evaluateAccessControl,
  type AccessControlAction,
  type AccessControlResource,
  type AccessDecision,
} from "@shared/accessControlV2";
import { canAccessModule } from "../../lib/permissionHelpers";

export const V2_EDITABLE_ROLES = [
  "Owner", "Manager", "POS", "Normal User", "View Only", "ERP Tester", CREATE_ONLY_ROLE,
] as const;

export interface V2RuleChange {
  resource: AccessControlResource;
  action: AccessControlAction;
  decision: AccessDecision;
}

export class V2PolicyError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "V2PolicyError";
  }
}

type PermissionSubject = { kind: "role"; roleKey: string } | { kind: "user"; userId: string };
interface RuleRow { resource_key: string; action_key: string; decision: AccessDecision }
interface VersionRow { revision: string; mode: string }
export interface V2PolicyActor { companyId: number; userId: string }

function revisionNumber(raw: string | number | null | undefined): number {
  const number = Number(raw ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new V2PolicyError(503, "POLICY_VERSION_INVALID", "Invalid permission policy revision");
  }
  return number;
}

const reserved = new Set(["system.users", "system.settings", "system.maintenance"]);
const immutableActions = new Set(["manage_settings", "manage_users", "repair"]);

export function assertV2ChangesSafe(role: string | null, changes: V2RuleChange[]): void {
  if (role === "Developer" || role === "Admin") {
    throw new V2PolicyError(403, "SYSTEM_ROLE_LOCKED", "Elevated roles cannot be edited here");
  }
  for (const change of changes) {
    if (
      !ACCESS_CONTROL_RESOURCES.includes(change.resource) ||
      !ACCESS_CONTROL_ACTIONS.includes(change.action) ||
      !["allow", "deny", "inherit"].includes(change.decision)
    ) {
      throw new V2PolicyError(400, "INVALID_POLICY_RULE", "Unrecognized resource, action, or decision");
    }
    // Only denials/inheritance can be staged for protected administration.
    if (change.decision === "allow" &&
      (reserved.has(change.resource) || immutableActions.has(change.action))) {
      throw new V2PolicyError(403, "PROTECTED_POLICY_ACTION", "Protected system permissions cannot be granted");
    }
    if (role === CREATE_ONLY_ROLE && change.decision === "allow" &&
      ["edit", "delete", "approve", "finalize", "void", "reverse", "import"].includes(change.action)) {
      throw new V2PolicyError(403, "CREATE_ONLY_IMMUTABLE", "Create Only cannot be granted editing or reversal powers");
    }
  }
  const keys = changes.map((c) => `${c.resource}:${c.action}`);
  if (new Set(keys).size !== keys.length) {
    throw new V2PolicyError(400, "DUPLICATE_POLICY_RULE", "Repeated resource/action entry in one update");
  }
}

export async function readV2Revision(companyId: number): Promise<{ revision: number; mode: string }> {
  const result = await pool.query<VersionRow>(
    "SELECT revision::text AS revision, mode FROM access_policy_versions WHERE company_id=$1", [companyId]
  );
  const current = result.rows[0];
  return { revision: revisionNumber(current?.revision), mode: current?.mode ?? "shadow" };
}

export async function readV2Roles(companyId: number) {
  const [templates, rules, version] = await Promise.all([
    pool.query(
      "SELECT role_key AS \"roleKey\", display_name AS \"displayName\", system_managed AS \"systemManaged\" FROM access_role_templates WHERE company_id=$1 ORDER BY role_key",
      [companyId]
    ),
    pool.query(
      `SELECT t.role_key AS "roleKey", r.resource_key AS "resource", r.action_key AS "action", r.decision
         FROM access_role_rules r JOIN access_role_templates t ON t.id=r.role_id AND t.company_id=r.company_id
        WHERE r.company_id=$1 ORDER BY t.role_key, r.resource_key, r.action_key`, [companyId]
    ),
    readV2Revision(companyId),
  ]);
  return {
    mode: version.mode, revision: version.revision,
    editableRoles: V2_EDITABLE_ROLES,
    templates: templates.rows, rules: rules.rows, enforced: false,
  };
}

export async function readV2Overrides(companyId: number, userId: string) {
  const result = await pool.query(
    `SELECT resource_key AS "resource", action_key AS "action", decision
       FROM access_user_overrides
      WHERE company_id=$1 AND user_id=$2 ORDER BY resource_key, action_key`,
    [companyId, userId]
  );
  return result.rows;
}

export async function assignedCompanyRole(companyId: number, userId: string): Promise<string> {
  const rows = await pool.query<{ role: string }>(
    "SELECT role FROM user_company_roles WHERE company_id=$1 AND user_id=$2 LIMIT 1", [companyId, userId]
  );
  if (!rows.rows[0]) {
    throw new V2PolicyError(404, "USER_NOT_IN_COMPANY", "User is not assigned to this company");
  }
  return rows.rows[0].role;
}

async function loadRules(client: PoolClient, companyId: number, subject: PermissionSubject): Promise<RuleRow[]> {
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
      WHERE company_id=$1 AND user_id=$2 ORDER BY resource_key, action_key`, [companyId, subject.userId]
  );
  return result.rows;
}

export async function saveV2Rules(input: {
  actor: V2PolicyActor;
  subject: PermissionSubject;
  changes: V2RuleChange[];
  expectedRevision: number;
  reason: string;
}): Promise<{ revision: number; mode: "shadow"; applied: number }> {
  const { actor, subject, changes, expectedRevision, reason } = input;
  if (subject.kind === "role") {
    if (!(V2_EDITABLE_ROLES as readonly string[]).includes(subject.roleKey)) {
      throw new V2PolicyError(403, "SYSTEM_ROLE_LOCKED", "This role cannot be configured");
    }
    assertV2ChangesSafe(subject.roleKey, changes);
  } else {
    if (subject.userId === actor.userId) {
      throw new V2PolicyError(403, "SELF_ESCALATION_FORBIDDEN", "Cannot edit your own overrides");
    }
    assertV2ChangesSafe(null, changes);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize all role and override saves for this company, even when
    // they edit different users. New companies begin at revision zero.
    await client.query(
      `INSERT INTO access_policy_versions(company_id, revision, mode, updated_by)
       VALUES($1,0,'shadow',$2) ON CONFLICT(company_id) DO NOTHING`,
      [actor.companyId, actor.userId]
    );
    const state = await client.query<VersionRow>(
      "SELECT revision::text AS revision, mode FROM access_policy_versions WHERE company_id=$1 FOR UPDATE",
      [actor.companyId]
    );
    const version = state.rows[0];
    if (!version || version.mode !== "shadow") {
      throw new V2PolicyError(409, "POLICY_NOT_SHADOW", "This company policy is not in shadow mode");
    }
    const revision = revisionNumber(version.revision);
    if (revision !== expectedRevision) {
      throw new V2PolicyError(409, "POLICY_STALE_REVISION", "Permissions changed; refresh before saving");
    }

    let roleId: string | null = null;
    if (subject.kind === "role") {
      const row = await client.query<{ id: string }>(
        `INSERT INTO access_role_templates(company_id, role_key, display_name, system_managed)
         VALUES($1,$2,$2,true)
         ON CONFLICT(company_id,role_key) DO UPDATE SET updated_at=access_role_templates.updated_at
         RETURNING id::text`, [actor.companyId, subject.roleKey]
      );
      roleId = row.rows[0]?.id ?? null;
      if (!roleId) throw new V2PolicyError(503, "ROLE_TEMPLATE_MISSING", "Role template is unavailable");
    } else {
      const userRow = await client.query<{ role: string }>(
        `SELECT role FROM user_company_roles WHERE company_id=$1 AND user_id=$2 FOR SHARE`,
        [actor.companyId, subject.userId]
      );
      if (userRow.rows.length === 0) {
        throw new V2PolicyError(404, "USER_NOT_IN_COMPANY", "User is not assigned to this company");
      }
      if (userRow.rows.some((x) => x.role === "Developer" || x.role === "Admin")) {
        throw new V2PolicyError(403, "SYSTEM_ROLE_LOCKED", "Cannot modify administrator overrides");
      }
      assertV2ChangesSafe(userRow.rows[0].role, changes);
    }

    const before = await loadRules(client, actor.companyId, subject);
    for (const change of changes) {
      if (subject.kind === "role") {
        await client.query(
          `INSERT INTO access_role_rules(company_id,role_id,resource_key,action_key,decision,updated_by)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(company_id,role_id,resource_key,action_key)
           DO UPDATE SET decision=EXCLUDED.decision, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
          [actor.companyId, roleId, change.resource, change.action, change.decision, actor.userId]
        );
      } else {
        await client.query(
          `INSERT INTO access_user_overrides(company_id,user_id,resource_key,action_key,decision,updated_by)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(company_id,user_id,resource_key,action_key)
           DO UPDATE SET decision=EXCLUDED.decision, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
          [actor.companyId, subject.userId, change.resource, change.action, change.decision, actor.userId]
        );
      }
    }
    const after = await loadRules(client, actor.companyId, subject);
    const nextRevision = revision + 1;
    await client.query(
      `UPDATE access_policy_versions SET revision=$2,updated_by=$3,updated_at=NOW()
       WHERE company_id=$1 AND mode='shadow'`, [actor.companyId, nextRevision, actor.userId]
    );
    await client.query(
      `INSERT INTO access_policy_change_audit
       (company_id,revision,actor_id,subject_type,subject_key,before_rules,after_rules,reason)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        actor.companyId, nextRevision, actor.userId, subject.kind,
        subject.kind === "role" ? subject.roleKey : subject.userId,
        JSON.stringify(before), JSON.stringify(after), reason,
      ]
    );
    await client.query("COMMIT");
    return { revision: nextRevision, mode: "shadow", applied: changes.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readV2Audit(companyId: number, limit: number) {
  const r = await pool.query(
    `SELECT revision::text, actor_id AS "actorId", subject_type AS "subjectType",
            subject_key AS "subjectKey", before_rules AS "beforeRules",
            after_rules AS "afterRules", reason, created_at AS "createdAt"
       FROM access_policy_change_audit WHERE company_id=$1
      ORDER BY revision DESC LIMIT $2`, [companyId, limit]
  );
  return r.rows;
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
      "SELECT feature_key,enabled FROM role_feature_permissions WHERE company_id=$1 AND role=$2", [companyId, role]
    ),
  ]);

  const module =
    resource.startsWith("factory.") ? "mod_factory" :
    resource.startsWith("retail.") ? "mod_pos" :
    resource.startsWith("properties.") ? "mod_properties" :
    resource.startsWith("system.") ? "mod_settings" :
    ["erp.accounts", "erp.vouchers"].includes(resource) ? "mod_accounting" :
    resource === "erp.analytics" ? "mod_analytics" :
    ["erp.stock_items", "erp.stock_transfers", "erp.inventory", "erp.containers"].includes(resource) ? "mod_inventory" :
    "mod_erp";

  const legacyModuleAllowed = role === CREATE_ONLY_ROLE ? null :
    canAccessModule(role, module, new Map(legacyRows.rows.map(x => [x.feature_key,x.enabled])));

  const evaluationInput = {
    role, companyId, isAssignedToCompany: true,
    resource, action, roleDecision: r.rows[0]?.decision,
    userDecision: u.rows[0]?.decision,
    legacyAllowed: legacyModuleAllowed ?? undefined,
  };
  const unverified = evaluateAccessControl({ ...evaluationInput, routeVerified: false });
  const hypothetical = evaluateAccessControl({ ...evaluationInput, routeVerified: true });
  return {
    companyId, role, userId: userId ?? null, resource, action,
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
