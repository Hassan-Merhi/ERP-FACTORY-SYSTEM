import { useLayoutEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingState } from "@/components/ui/page-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "./erpAccessQuery";
import type { ErpFeatureAccess } from "./erpAccess";

export type ErpPageAccess = ErpFeatureAccess;

export const ERP_ACCESS_BOUNDARY_STATE = {
  loading: "loading",
  error: "error",
  ready: "ready",
} as const;

export type ErpAccessBoundaryState = (typeof ERP_ACCESS_BOUNDARY_STATE)[keyof typeof ERP_ACCESS_BOUNDARY_STATE];

/** A failed background recheck must not discard valid access for the current company.
 * Initial checks and explicit 4xx denials still block the workspace. */
export function isRecoverableErpAccessRefreshError(error: unknown): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  const status = (error as { status?: unknown }).status;
  // fetch() transport failures have no HTTP status; 408/429/5xx are retryable.
  // Never reuse an old grant after an explicit 400/401/403/other client denial.
  if (status == null) return true;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

interface ResolveErpAccessBoundaryStateInput {
  hasUser: boolean;
  companyId: number | string | null | undefined;
  hasAccessData: boolean;
  hasQueryError: boolean;
  hasRecoverableQueryError?: boolean;
  synchronizedCompanyId: number | string | null;
}

export function resolveErpAccessBoundaryState({
  hasUser,
  companyId,
  hasAccessData,
  hasQueryError,
  hasRecoverableQueryError = false,
  synchronizedCompanyId,
}: ResolveErpAccessBoundaryStateInput): ErpAccessBoundaryState {
  if (!hasUser || companyId == null) return ERP_ACCESS_BOUNDARY_STATE.loading;
  const verifiedForCurrentCompany = hasAccessData && String(synchronizedCompanyId) === String(companyId);
  // Keep working only when we already verified THIS company's grants and a
  // subsequent refresh failed transiently. Never open on initial failure,
  // cross-company cached grants, or an authorization/validation denial.
  if (hasQueryError && !(hasRecoverableQueryError && verifiedForCurrentCompany)) {
    return ERP_ACCESS_BOUNDARY_STATE.error;
  }
  if (!verifiedForCurrentCompany) {
    return ERP_ACCESS_BOUNDARY_STATE.loading;
  }
  return ERP_ACCESS_BOUNDARY_STATE.ready;
}

interface ErpAccessBoundaryProps {
  user: unknown;
  children: ReactNode;
}

export function ErpAccessBoundary({ user, children }: ErpAccessBoundaryProps) {
  const { selectedCompany } = useCompany();
  const { t } = useApplicationLanguage();
  const companyId = selectedCompany?.id;
  const [synchronizedCompanyId, setSynchronizedCompanyId] = useState<number | string | null>(null);

  const accessQuery = useQuery<ErpPageAccess>({
    ...erpPageAccessQueryOptions(companyId, Boolean(user)),
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 2_000),
    refetchOnReconnect: true,
  });

  useLayoutEffect(() => {
    if (companyId == null || !accessQuery.data) return;

    // Permission readers now use the scoped key directly; no global cache mirror.
    setSynchronizedCompanyId(companyId);
  }, [accessQuery.data, companyId]);

  const boundaryState = resolveErpAccessBoundaryState({
    hasUser: Boolean(user),
    companyId,
    hasAccessData: Boolean(accessQuery.data),
    hasQueryError: accessQuery.isError,
    hasRecoverableQueryError: isRecoverableErpAccessRefreshError(accessQuery.error),
    synchronizedCompanyId,
  });

  if (boundaryState === ERP_ACCESS_BOUNDARY_STATE.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 sm:p-6">
        <ErrorState
          className="w-full max-w-xl"
          actionLabel={t("common.refresh")}
          onAction={() => void accessQuery.refetch()}
          actionPending={accessQuery.isFetching}
        />
      </div>
    );
  }

  if (boundaryState === ERP_ACCESS_BOUNDARY_STATE.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 sm:p-6">
        <LoadingState className="w-full max-w-xl" />
      </div>
    );
  }

  // A temporary failure to refresh an already verified grant must not replace
  // the entire workspace after posting a voucher (or any other transaction).
  // Backend authorization remains authoritative for each protected request.
  if (accessQuery.isError && isRecoverableErpAccessRefreshError(accessQuery.error)) {
    return (
      <>
        {children}
        <div
          role="status"
          data-testid="erp-access-refresh-warning"
          className="fixed bottom-4 right-4 z-[100] flex max-w-sm items-center gap-3 rounded-lg border bg-background p-3 text-xs text-foreground shadow-lg"
        >
          <span>Page permissions could not be refreshed. Your workspace is still available.</span>
          <button
            type="button"
            className="shrink-0 rounded-md border px-3 py-2 font-medium hover:bg-muted disabled:opacity-50"
            disabled={accessQuery.isFetching}
            onClick={() => void accessQuery.refetch()}
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  return children;
}
