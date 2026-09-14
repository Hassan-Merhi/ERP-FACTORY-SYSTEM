import { useEffect } from "react";
import { useLocation } from "wouter";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { PosRoutes } from "./PosRoutes";
import { ErpRoutes } from "./ErpRoutes";
import type { AuthMe } from "@shared/apiTypes";

const SpGoldenCoast = lazy(() => import("@/pages/sp/SpGoldenCoast"));
const RetailDashboard = lazy(() => import("@/pages/retail/RetailDashboard"));
const RetailInventory = lazy(() => import("@/pages/retail/RetailInventory"));

interface RouterProps {
  user: AuthMe;
  posImportEnabled?: boolean;
}

/**
 * Top-level route dispatcher.
 *
 * - Handles the legacy /pos → / redirect for POS users.
 * - Delegates to PosRoutes for user.role === "POS".
 * - Hosts company-type workspaces that sit outside the normal ERP route table.
 * - Delegates all other authenticated ERP routes to ErpRoutes.
 */
export function Router({ user, posImportEnabled }: RouterProps) {
  const isPOS = user?.role === "POS";
  const [location, navigate] = useLocation();

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

  if (location === "/retail/dashboard") {
    return <RetailDashboard />;
  }

  if (location === "/retail" || location === "/retail/inventory" || location.startsWith("/retail/products/")) {
    return <RetailInventory />;
  }

  if (location.startsWith("/retail/")) {
    return <RetailDashboard />;
  }

  return <ErpRoutes user={user} />;
}