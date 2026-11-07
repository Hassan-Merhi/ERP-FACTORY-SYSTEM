/**
 * Phase 6 UI permission adapter.
 *
 * UI checks are advisory; existing API authentication and hard guards remain
 * authoritative. V2 shadow rules MUST NOT grant access or override legacy
 * restrictions. Every operation still needs its real backend boundary.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy } from "@/lib/queryPolicies";
import type { AccessControlResource, AccessControlAction } from "@shared/accessControlV2";

export type LegacyPermissionRow = { featureKey: string; enabled: boolean };
export type CanReason =
  | "allowed_by_legacy"
  | "missing_company"
  | "loading"
  | "permission_unavailable"
  | "legacy_restricted"
  | "view_only"
  | "create_only_unverified"
  | "tester_settings"
  | "caller_restricted";
export interface CanResult {
  allowed: boolean;
  pending: boolean;
  reason: CanReason;
}

const MUTATING = new Set<AccessControlAction>([
  "create",
  "edit",
  "delete",
  "approve",
  "finalize",
  "void",
  "reverse",
  "import",
  "manage_settings",
  "manage_users",
  "repair",
]);
const CREATE_ONLY_DENIED = new Set<AccessControlAction>([
  "edit",
  "delete",
  "approve",
  "finalize",
  "void",
  "reverse",
  "import",
  "manage_settings",
  "manage_users",
  "repair",
]);

export function decideLegacyCan(input: {
  role: string | null | undefined;
  companyId: number | null | undefined;
  resource: AccessControlResource;
  action: AccessControlAction;
  legacyAllowed: boolean;
  featureKey?: string;
  permissions?: readonly LegacyPermissionRow[];
  permissionsReady?: boolean;
  permissionsError?: boolean;
  /** Explicitly handler-verified Create Only writes, not inferred from URLs. */
  verifiedCreateOnly?: boolean;
}): CanResult {
  const {
    role,
    companyId,
    resource,
    action,
    legacyAllowed,
    featureKey,
    permissions,
    permissionsReady,
    permissionsError,
  } = input;
  if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0 || !role) {
    return { allowed: false, pending: false, reason: "missing_company" };
  }
  if (!legacyAllowed) return { allowed: false, pending: false, reason: "caller_restricted" };
  if (role === "ERP Tester" && resource.startsWith("system.")) {
    return { allowed: false, pending: false, reason: "tester_settings" };
  }
  if (role === "View Only" && MUTATING.has(action)) {
    return { allowed: false, pending: false, reason: "view_only" };
  }
  if (
    role === "Create Only" &&
    (CREATE_ONLY_DENIED.has(action) || (action === "create" && input.verifiedCreateOnly !== true))
  ) {
    return { allowed: false, pending: false, reason: "create_only_unverified" };
  }
  if (role === "Create Only" && resource.startsWith("system.")) {
    return { allowed: false, pending: false, reason: "create_only_unverified" };
  }

  if (featureKey && role !== "Admin" && role !== "Developer") {
    if (permissionsError) return { allowed: false, pending: false, reason: "permission_unavailable" };
    if (!permissionsReady || !permissions) return { allowed: false, pending: true, reason: "loading" };
    const stored = permissions.find((item) => item.featureKey === featureKey)?.enabled;
    const allowed = role === "Normal User" ? stored === true : stored !== false;
    if (!allowed) return { allowed: false, pending: false, reason: "legacy_restricted" };
  }
  return { allowed: true, pending: false, reason: "allowed_by_legacy" };
}

export function useCan(
  resource: AccessControlResource,
  action: AccessControlAction,
  options: { legacyAllowed: boolean; featureKey?: string; verifiedCreateOnly?: boolean }
): CanResult {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const role = selectedCompany?.role ?? null;
  const hasContext = !!companyId && !!role;
  const query = useQuery<LegacyPermissionRow[]>({
    queryKey: companyQueryKey("/api/my-permissions", companyId ?? undefined),
    ...accessQueryPolicy,
    enabled: hasContext && !!options.featureKey && role !== "Admin" && role !== "Developer",
    refetchOnWindowFocus: true,
    refetchInterval: hasContext && !!options.featureKey ? 30_000 : false,
  });
  return useMemo(
    () =>
      decideLegacyCan({
        role,
        companyId,
        resource,
        action,
        legacyAllowed: options.legacyAllowed,
        featureKey: options.featureKey,
        verifiedCreateOnly: options.verifiedCreateOnly,
        permissions: query.data,
        permissionsReady: query.isSuccess,
        permissionsError: query.isError,
      }),
    [
      role,
      companyId,
      resource,
      action,
      options.legacyAllowed,
      options.featureKey,
      options.verifiedCreateOnly,
      query.data,
      query.isSuccess,
      query.isError,
    ]
  );
}

/** Short, accessible feedback for disabled operations. */
export function canDenialMessage(reason: CanReason): string {
  switch (reason) {
    case "loading":
      return "Checking your access permissions.";
    case "permission_unavailable":
      return "Permissions could not be verified. Refresh or contact an administrator.";
    case "view_only":
      return "View Only users cannot change business records.";
    case "create_only_unverified":
      return "This operation is not approved for Create Only users.";
    case "tester_settings":
      return "ERP Tester cannot manage settings.";
    case "legacy_restricted":
      return "Your company role does not allow this action.";
    case "missing_company":
      return "Select an authorized company to continue.";
    case "caller_restricted":
      return "This operation is restricted for your current account.";
    default:
      return "";
  }
}
