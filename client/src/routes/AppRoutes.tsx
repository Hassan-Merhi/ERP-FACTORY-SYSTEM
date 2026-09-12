import { useEffect } from "react";
import { useLocation } from "wouter";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { PosRoutes } from "./PosRoutes";
import { ErpRoutes } from "./ErpRoutes";
import type { AuthMe } from "@shared/apiTypes";

const SpGoldenCoast = lazy(() => import("@/pages/sp/SpGoldenCoast"));

interface RouterProps {
  user: AuthMe;
  posImportEnabled?: boolean;
}

/**
 * Top-level route dispatcher.
 *
 * - Handles the legacy /pos → / redirect for POS users.
 * - Delegates to PosRoutes for user.role === "POS".
 * - Hosts the lazy-loaded Golden Coast operations integration route inside the ERP shell.
 * - Delegates all other authenticated ERP routes to ErpRoutes.
 *
 * Named "Router" so App.tsx callers require no JSX changes after the import
 * path moves from an inline definition to this module.
 */
export function Router({ user, posImportEnabled }: RouterProps) {
  const isPOS = user?.role === "POS";
  const [location, navigate] = useLocation();

  // Redirect legacy /pos URL to / for POS users
  useEffect(() => {
    if (isPOS && window.location.pathname === "/pos") {
      navigate("/");
    }
  }, [isPOS, navigate]);

  if (isPOS) {
    return <PosRoutes user={user} posImportEnabled={posImportEnabled} />;
  }

  if (location === "/sp/golden-coast") {
    return <SpGoldenCoast />;
  }

  return <ErpRoutes user={user} />;
}
