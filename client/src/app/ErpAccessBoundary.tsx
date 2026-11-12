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

interface ResolveErpAccessBoundaryStateInput {
  hasUser: boolean;
  companyId: number | string | null | undefined;
  hasAccessData: boolean;
  hasQueryError: boolean;
  synchronizedCompanyId: number | string | null;
}

export function resolveErpAccessBoundaryState({
  hasUser,
  companyId,
  hasAccessData,
  hasQueryError,
  synchronizedCompanyId,
}: ResolveErpAccessBoundaryStateInput): ErpAccessBoundaryState {
  if (!hasUser || companyId == null) return ERP_ACCESS_BOUNDARY_STATE.loading;
  if (hasQueryError) return ERP_ACCESS_BOUNDARY_STATE.error;
  if (!hasAccessData || String(synchronizedCompanyId) !== String(companyId)) {
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
    synchronizedCompanyId,
  });

  if (boundaryState === ERP_ACCESS_BOUNDARY_STATE.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 sm:p-6">
        <ErrorState
          className="w-full max-w-xl"
          actionLabel={t("common.refresh")}
          onAction={() => window.location.reload()}
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

  return children;
}
