import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { PosRoutes } from "./PosRoutes";
import { ErpRoutes } from "./ErpRoutes";
import type { AuthMe } from "@shared/apiTypes";

const SpGoldenCoast = lazy(() => import("@/pages/sp/SpGoldenCoast"));
const RetailDashboard = lazy(() => import("@/pages/retail/RetailDashboard"));
const RetailInventory = lazy(() => import("@/pages/retail/RetailInventory"));
const RetailPOS = lazy(() => import("@/pages/pos/RetailPOS"));
const RetailStockCount = lazy(() => import("@/pages/retail/RetailStockCount"));
const RetailSalesHistory = lazy(() => import("@/pages/retail/RetailSalesHistory"));

interface RouterProps {
  user: AuthMe;
  posImportEnabled?: boolean;
}

/**
 * Top-level route dispatcher.
 *
 * - Handles the legacy /pos → / redirect for POS users.
 * - Delegates to PosRoutes for user.role === "POS".
 * - Hosts only the retail modules that genuinely differ from normal ERP.
 * - Delegates dashboard, accounts, vouchers, daybook, parties and all other ERP pages to ErpRoutes.
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

  if (location === "/retail/pos") {
    return <RetailPOS />;
  }

  // Retired intake/stock-operations bookmarks cannot open manual stock writes.
  if (location === "/retail/quick-add" || location === "/retail/stock") {
    return <Redirect replace to="/retail/inventory" />;
  }

  if (location === "/retail/stock-count") {
    return <RetailStockCount />;
  }

  if (location === "/retail/history") {
    return <RetailSalesHistory />;
  }

  if (location === "/retail/reports") {
    return <RetailDashboard />;
  }

  if (location === "/retail" || location === "/retail/inventory" || location.startsWith("/retail/products/")) {
    return <RetailInventory />;
  }

  return <ErpRoutes user={user} />;
}
