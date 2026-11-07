/**
 * Permissions Control Center V2 — effective permission reads and the audited
 * company policy mode change.
 *
 * Every read resolves the person's role from canonical company membership
 * (user_company_roles), never from the session or the request body. Nothing is
 * cached: each request reads the committed policy, so an approved change
 * applies to the next request in every session.
 */
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { buildPermissionMap, canAccessModule } from "../../lib/permissionHelpers";
import {
  LEGACY_MODULE_KEYS,
  computeEffectivePermissions,
  type EffectivePermissionMatrix,
  type V2PolicyMode,
  type V2RuleRow,
} from "@shared/effectivePermissions";
import { V2PolicyError, type V2PolicyActor } from "./accessControlV2Store";
import { isV2EnforcementEnabled, refuseV2ModeTransition } from "./permissionsV2Activation";

const SCHEMA_MISSING_CODES = new Set(["42P01", "42703", "42883"]);
const POLICY_MODES: ReadonlySet<string> = new Set(["shadow", "active", "rolled_back"]);

type Queryable = Pick<PoolClient, "query">;

function isSchemaMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

function toMode(raw: unknown): V2PolicyMode {
  return typeof raw === "string" && POLICY_MODES.has(raw) ? (raw as V2PolicyMode) : "shadow";
}

/** Canonical company role, or null when the person is not a member. */
export async function canonicalCompanyRole(
  companyId: number,
  userId: string,
  db: Queryable = pool
): Promise<string | null> {
  const result = await db.query<{ role: string }>(
    "SELECT role FROM user_company_roles WHERE company_id=$1 AND user_id=$2 ORDER BY id LIMIT 1",
    [companyId, userId]
  );
  return result.rows[0]?.role ?? null;
}

async function loadLegacyModules(companyId: number, role: string, db: Queryable): Promise<Record<string, boolean>> {
  const rows = await db.query<{ feature_key: string; enabled: boolean }>(
    "SELECT feature_key, enabled FROM role_feature_permissions WHERE company_id=$1 AND role=$2",
    [companyId, role]
  );
  const permissionMap = buildPermissionMap(
    rows.rows.map((row) => ({ role, featureKey: row.feature_key, enabled: row.enabled })),
    role
  );
  return Object.fromEntries(LEGACY_MODULE_KEYS.map((key) => [key, canAccessModule(role, key, permissionMap)]));
}

export interface V2PolicySnapshot {
  available: boolean;
  mode: V2PolicyMode;
  revision: number;
  roleRules: V2RuleRow[];
  userRules: V2RuleRow[];
}

/**
 * V2 rules for one role and one person. A missing V2 schema (migration not yet
 * applied) yields `available: false`, which leaves every decision on legacy.
 */
export async function loadV2PolicySnapshot(
  companyId: number,
  role: string,
  userId: string,
  db: Queryable = pool
): Promise<V2PolicySnapshot> {
  try {
    const [version, roleRules, userRules] = await Promise.all([
      db.query<{ revision: string; mode: string }>(
        "SELECT revision::text AS revision, mode FROM access_policy_versions WHERE company_id=$1",
        [companyId]
      ),
      db.query<V2RuleRow>(
        `SELECT r.resource_key AS "resource", r.action_key AS "action", r.decision
           FROM access_role_rules r
           JOIN access_role_templates t ON t.id=r.role_id AND t.company_id=r.company_id
          WHERE r.company_id=$1 AND t.role_key=$2`,
        [companyId, role]
      ),
      db.query<V2RuleRow>(
        `SELECT resource_key AS "resource", action_key AS "action", decision
           FROM access_user_overrides WHERE company_id=$1 AND user_id=$2`,
        [companyId, userId]
      ),
    ]);
    const revision = Number(version.rows[0]?.revision ?? 0);
    return {
      available: true,
      mode: toMode(version.rows[0]?.mode),
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      roleRules: roleRules.rows,
      userRules: userRules.rows,
    };
  } catch (error) {
    if (isSchemaMissing(error)) {
      return { available: false, mode: "shadow", revision: 0, roleRules: [], userRules: [] };
    }
    throw error;
  }
}

/**
 * Effective permissions for a company member. Throws 404 USER_NOT_IN_COMPANY
 * when the person has no role in the company, so no matrix ever describes a
 * company the person cannot enter.
 */
export async function readEffectivePermissions(
  companyId: number,
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<EffectivePermissionMatrix> {
  const role = await canonicalCompanyRole(companyId, userId);
  if (!role) throw new V2PolicyError(404, "USER_NOT_IN_COMPANY", "User is not assigned to this company");
  const [legacyModules, v2] = await Promise.all([
    loadLegacyModules(companyId, role, pool),
    loadV2PolicySnapshot(companyId, role, userId),
  ]);
  return computeEffectivePermissions({
    companyId,
    userId,
    role,
    legacyModules,
    v2,
    enforcementEnabled: isV2EnforcementEnabled(env),
  });
}

/** Policy mode and revision for a company, without the rules. */
export async function readV2PolicyStatus(
  companyId: number,
  db: Queryable = pool
): Promise<{ available: boolean; mode: V2PolicyMode; revision: number }> {
  try {
    const result = await db.query<{ revision: string; mode: string }>(
      "SELECT revision::text AS revision, mode FROM access_policy_versions WHERE company_id=$1",
      [companyId]
    );
    return {
      available: true,
      mode: toMode(result.rows[0]?.mode),
      revision: Number(result.rows[0]?.revision ?? 0),
    };
  } catch (error) {
    if (isSchemaMissing(error)) return { available: false, mode: "shadow", revision: 0 };
    throw error;
  }
}

/**
 * Change a company's V2 policy mode in one transaction: revision check, mode
 * change, revision increment and audit row commit together or not at all.
 */
export async function setV2PolicyMode(
  input: {
    actor: V2PolicyActor;
    mode: V2PolicyMode;
    expectedRevision: number;
    reason: string;
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ revision: number; mode: V2PolicyMode; previousMode: V2PolicyMode }> {
  const { actor, mode, expectedRevision, reason } = input;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO access_policy_versions(company_id, revision, mode, updated_by)
       VALUES($1,0,'shadow',$2) ON CONFLICT(company_id) DO NOTHING`,
      [actor.companyId, actor.userId]
    );
    const state = await client.query<{ revision: string; mode: string }>(
      "SELECT revision::text AS revision, mode FROM access_policy_versions WHERE company_id=$1 FOR UPDATE",
      [actor.companyId]
    );
    const revision = Number(state.rows[0]?.revision ?? 0);
    const previousMode = toMode(state.rows[0]?.mode);
    if (revision !== expectedRevision) {
      throw new V2PolicyError(409, "POLICY_STALE_REVISION", "Permissions changed; refresh before saving");
    }
    const refusal = refuseV2ModeTransition(previousMode, mode, env);
    if (refusal) throw new V2PolicyError(refusal.status, refusal.code, refusal.message);
    const nextRevision = revision + 1;
    await client.query(
      "UPDATE access_policy_versions SET mode=$2, revision=$3, updated_by=$4, updated_at=NOW() WHERE company_id=$1",
      [actor.companyId, mode, nextRevision, actor.userId]
    );
    await client.query(
      `INSERT INTO access_policy_change_audit
       (company_id,revision,actor_id,subject_type,subject_key,before_rules,after_rules,reason)
       VALUES($1,$2,$3,'policy_mode',$4,$5::jsonb,$6::jsonb,$7)`,
      [
        actor.companyId,
        nextRevision,
        actor.userId,
        mode,
        // Same row shape as rule audits so the existing audit viewer shows
        // the change as "policy:mode shadow -> active".
        JSON.stringify([{ resource: "policy", action: "mode", decision: previousMode }]),
        JSON.stringify([{ resource: "policy", action: "mode", decision: mode }]),
        reason,
      ]
    );
    await client.query("COMMIT");
    return { revision: nextRevision, mode, previousMode };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
