import { useEffect } from "react";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";

/**
 * Offline read scope follows the verified session: it is revoked on any
 * company/user change, re-verified when the browser comes back online, and
 * revoked when another tab logs out or switches company.
 */
export function useOfflineReadScopeLifecycle(selectedCompanyId: number | null, authenticatedUserId: string): void {
  useEffect(() => {
    if (!OFFLINE_MODE_ENABLED) return;
    let stopped = false;
    void import("@/lib/offline/offlineReadCache")
      .then(async ({ revokeOfflineReadScope, verifyOfflineReadScope }) => {
        if (stopped) return;
        revokeOfflineReadScope();
        if (selectedCompanyId && navigator.onLine) {
          await verifyOfflineReadScope(selectedCompanyId);
        }
      })
      .catch(() => {});

    const restoreVerification = () => {
      if (stopped || !selectedCompanyId) return;
      void import("@/lib/offline/offlineReadCache")
        .then(({ verifyOfflineReadScope }) => verifyOfflineReadScope(selectedCompanyId))
        .catch(() => {});
    };
    const onOtherTabIdentityChanged = (event: StorageEvent) => {
      if (event.key === "erp_offline_logout_broadcast" || event.key === "selectedCompanyId" || event.key === null) {
        void import("@/lib/offline/offlineReadCache")
          .then(({ revokeOfflineReadScope }) => revokeOfflineReadScope())
          .catch(() => {});
      }
    };
    window.addEventListener("online", restoreVerification);
    window.addEventListener("storage", onOtherTabIdentityChanged);
    return () => {
      stopped = true;
      window.removeEventListener("online", restoreVerification);
      window.removeEventListener("storage", onOtherTabIdentityChanged);
      void import("@/lib/offline/offlineReadCache")
        .then(({ revokeOfflineReadScope }) => revokeOfflineReadScope())
        .catch(() => {});
    };
  }, [selectedCompanyId, authenticatedUserId]);
}
