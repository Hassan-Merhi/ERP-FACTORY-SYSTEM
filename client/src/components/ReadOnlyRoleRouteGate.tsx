/**
 * Route-level presentation gate for the roles that never change existing
 * records (View Only and Create Only).
 *
 * Pages whose whole purpose is to change existing records (edit, import,
 * approve, finalize, repair, settings) show a clear explanation instead of a
 * form the server would refuse; voucher edit links open the read-only voucher
 * view. Create Only additionally cannot open creation pages that are not
 * handler-verified on the server. The decision comes from the shared page
 * catalog (shared/permissionPageCatalog.ts) and follows the active company
 * role, so it changes as soon as the user switches company.
 *
 * This is presentation only. The server refuses the same writes whatever the
 * browser shows.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { decideReadOnlyRoleRoute } from "@shared/permissionPageCatalog";

export const READ_ONLY_ROUTE_CHANGE_MESSAGE =
  "This page changes existing records. Your role can view records but cannot edit, delete, approve, import or repair them.";
export const READ_ONLY_ROUTE_CREATE_MESSAGE =
  "This page creates a kind of record that is not available to Create Only users. You can still add the approved new records shown on other pages.";

export function ReadOnlyRoleRouteGate({ role, children }: { role: string | null | undefined; children: ReactNode }) {
  const [location, navigate] = useLocation();
  const decision = useMemo(() => decideReadOnlyRoleRoute(role, location), [role, location]);

  useEffect(() => {
    if (decision.kind === "redirect") navigate(decision.to, { replace: true });
  }, [decision, navigate]);

  if (decision.kind === "redirect") return null;
  if (decision.kind === "allow") return <>{children}</>;

  const message =
    decision.reason === "unverified_create" ? READ_ONLY_ROUTE_CREATE_MESSAGE : READ_ONLY_ROUTE_CHANGE_MESSAGE;
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="read-only-role-route-notice"
      data-permission-page={decision.pageId}
      className="mx-auto mt-6 max-w-xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <h1 className="text-base font-semibold">This page is not available to your role</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
          <p className="text-xs text-muted-foreground">Ask a company administrator if you need this access.</p>
          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="read-only-role-route-back"
              onClick={() => {
                if (window.history.length > 1) window.history.back();
                else navigate("/", { replace: true });
              }}
            >
              Go back
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
