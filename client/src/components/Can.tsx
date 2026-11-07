import type { ReactNode } from "react";
import type { AccessControlAction, AccessControlResource } from "@shared/accessControlV2";
import { canDenialMessage, useCan } from "@/hooks/useCan";

/**
 * Phase 6 visibility boundary for presentation only.
 * It never substitutes for middleware and never relies on shadow V2 grants.
 */
export function Can({
  resource,
  action,
  legacyAllowed,
  featureKey,
  verifiedCreateOnly,
  children,
  fallback = null,
  showExplanation = false,
}: {
  resource: AccessControlResource;
  action: AccessControlAction;
  legacyAllowed: boolean;
  featureKey?: string;
  verifiedCreateOnly?: boolean;
  children: ReactNode;
  fallback?: ReactNode;
  showExplanation?: boolean;
}) {
  const decision = useCan(resource, action, { legacyAllowed, featureKey, verifiedCreateOnly });
  if (decision.allowed) return <>{children}</>;
  if (!showExplanation) return <>{fallback}</>;
  return (
    <div role="status" className="text-xs text-muted-foreground">
      {canDenialMessage(decision.reason)}
    </div>
  );
}
