// Extracted from ./ErpRoutes.tsx to keep that module under the source-size cap.
import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Route, Redirect } from "wouter";
import { canAccessAnyErpFeature, canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCompany } from "@/contexts/CompanyContext";
import { canEnterErpGuardedRoute, effectiveErpRole, isErpRouteRoleAllowed } from "@shared/erpNavigationPolicy";
import type { FeatureKey } from "@shared/schema";

export interface ErpRouteUser {
  role?: string | null;
  currentRole?: string | null;
}

export type RouteComponent = ComponentType;

/** Company-aware ERP access and role guards shared by every ERP route (G: feature-gated, R: explicit flag). */
export function useErpRouteGuards(user: ErpRouteUser) {
  const { selectedCompany } = useCompany();
  const { data: erpAccess } = useQuery<ErpFeatureAccess>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, Boolean(user)),
  });

  const effectiveRole = effectiveErpRole(user);
  const roleAllowed = (path: string) => isErpRouteRoleAllowed(path, effectiveRole);
  const canAccess = (key: FeatureKey) => canAccessErpFeature(erpAccess, key);
  const canAccessAny = (keys: readonly FeatureKey[]) => canAccessAnyErpFeature(erpAccess, keys);
  const G = (path: string, key: FeatureKey, Comp: RouteComponent) =>
    canAccess(key) && roleAllowed(path) ? (
      <Route path={path} component={Comp} />
    ) : (
      <Route path={path}>
        <Redirect replace to="/tracking" />
      </Route>
    );
  const R = (path: string, allowed: boolean, Comp: RouteComponent) =>
    allowed && canEnterErpGuardedRoute(path, effectiveRole) ? (
      <Route path={path} component={Comp} />
    ) : (
      <Route path={path}>
        <Redirect replace to="/tracking" />
      </Route>
    );
  return { erpAccess, effectiveRole, roleAllowed, canAccess, canAccessAny, G, R };
}
