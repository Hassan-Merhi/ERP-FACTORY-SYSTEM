import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { getParentRoute, isFactoryTopLevelPath } from "@/lib/parent-routes";
import { goBackToPreviousErpLocation } from "@/lib/erp-navigation-history";
import { useGlobalScrollKeys } from "./useGlobalScrollKeys";

declare global {
  interface Window {
    __escBackGuard?: () => boolean;
    __escBackConfirm?: () => void;
  }
}

function getSupplierPartnerParent(pathname: string): string | null {
  const cleanPath = pathname.split("?")[0].split("#")[0];

  if (cleanPath === "/sp/reports") return "/sp";
  if (cleanPath === "/sp/opening-stock") return "/sp";
  if (cleanPath === "/sp/aliases") return "/sp";
  if (cleanPath === "/sp/setup") return "/sp";
  if (cleanPath === "/sp/migration" || cleanPath === "/sp/gc-migration") {
    return "/sp/setup";
  }

  return null;
}

/**
 * Manages app-level navigation state:
 *   - Leave-confirmation dialog (triggered when __escBackGuard is active)
 *   - navigateToParent / handleGoBack / handleConfirmLeave callbacks
 *   - Global arrow / PageUp / PageDown / Home / End / Escape key handling
 *     via useGlobalScrollKeys
 */
export function useAppNavigation() {
  const [, setLocation] = useLocation();
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const navigateToParent = useCallback(() => {
    // ERP navigation is history-first so Esc/Back returns to the exact page,
    // tab, query and list context that opened the current page. The helper
    // only succeeds for entries created while the ERP shell was active.
    if (goBackToPreviousErpLocation()) return;

    const pathname = window.location.pathname;
    const parent = getSupplierPartnerParent(pathname) ?? getParentRoute(pathname);
    if (parent) {
      setLocation(parent);
    } else if (isFactoryTopLevelPath(pathname)) {
      // Top-level Factory pages have no parent; history.back() here returned to whatever page came
      // before, including ERP pages, so Escape could leave Factory Mode.
      return;
    } else if (window.history.length > 1) {
      window.history.back();
    }
  }, [setLocation]);

  const handleGoBack = useCallback(() => {
    if (window.__escBackGuard && window.__escBackGuard()) {
      setShowLeaveConfirm(true);
      return;
    }
    navigateToParent();
  }, [navigateToParent]);

  const handleConfirmLeave = useCallback(() => {
    setShowLeaveConfirm(false);
    if (window.__escBackConfirm) {
      window.__escBackConfirm();
    }
    navigateToParent();
  }, [navigateToParent]);

  // Keep one app-level Escape handler registered so every ERP page goes
  // through the same exact-history path even when it has no page-specific hook.
  useEscapeBack(handleGoBack);
  useGlobalScrollKeys(handleGoBack);

  return { showLeaveConfirm, setShowLeaveConfirm, handleGoBack, handleConfirmLeave };
}
