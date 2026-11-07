import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  CREATE_ONLY_ROLE,
  type AccessControlAction,
  type AccessControlResource,
  type AccessDecision,
} from "@shared/accessControlV2";

export type RoleRule = {
  roleKey: string;
  resource: AccessControlResource;
  action: AccessControlAction;
  decision: AccessDecision;
};
export type RoleChange = Omit<RoleRule, "roleKey">;
export type RoleRuleKey = `${AccessControlResource}:${AccessControlAction}`;

export const matrixActions = ACCESS_CONTROL_ACTIONS;
export const matrixResources = ACCESS_CONTROL_RESOURCES;
export const decisions = ["inherit", "allow", "deny"] as const;

export function ruleKey(resource: AccessControlResource, action: AccessControlAction): RoleRuleKey {
  return `${resource}:${action}`;
}
export function roleRulesFor(rules: RoleRule[], role: string): Map<RoleRuleKey, AccessDecision> {
  return new Map(
    rules
      .filter((entry) => entry.roleKey === role)
      .map((entry) => [ruleKey(entry.resource, entry.action), entry.decision])
  );
}
/** UI and server share the same immutable baseline. Backend remains authoritative. */
export function canStageRoleDecision(
  role: string,
  resource: AccessControlResource,
  action: AccessControlAction,
  decision: AccessDecision
): boolean {
  if (decision !== "allow") return true;
  if (resource.startsWith("system.")) return false;
  if (action === "manage_settings" || action === "manage_users" || action === "repair") return false;
  if (
    role === CREATE_ONLY_ROLE &&
    ["edit", "delete", "approve", "finalize", "void", "reverse", "import"].includes(action)
  )
    return false;
  return true;
}
export function pendingRoleChanges(
  saved: Map<RoleRuleKey, AccessDecision>,
  edited: Map<RoleRuleKey, AccessDecision>
): RoleChange[] {
  const result: RoleChange[] = [];
  for (const resource of matrixResources) {
    for (const action of matrixActions) {
      const key = ruleKey(resource, action);
      const before = saved.get(key) ?? "inherit";
      const after = edited.get(key) ?? "inherit";
      if (before !== after) result.push({ resource, action, decision: after });
    }
  }
  return result;
}
export function readableResource(resource: string): string {
  return resource
    .split(".")[1]
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
