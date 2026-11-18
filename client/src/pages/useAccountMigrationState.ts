// Extracted from ./AccountMigration.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Company, LedgerAccount } from "@shared/schema";
import type { ExecuteResult, PendingMigration, PreviewResult } from "./AccountMultiSelect";

export function useAccountMigrationState() {
  const { toast } = useToast();

  const [srcCompanyId, setSrcCompanyId] = useState<string>("");
  const [destCompanyId, setDestCompanyId] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoTarget, setUndoTarget] = useState<PendingMigration | null>(null);

  const {
    data: companies = [],
    isLoading: loadingCompanies,
    isError: companiesError,
    refetch: refetchCompanies,
  } = useQuery<Company[]>({
    queryKey: ["/api/admin/account-migration/companies"],
    queryFn: async () => {
      const res = await fetch("/api/admin/account-migration/companies", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load companies (${res.status})`);
      }
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.companies) ? body.companies : [];
    },
    staleTime: 0,
  });

  const {
    data: srcAccounts = [],
    isLoading: loadingSrcAccounts,
    isError: srcAccountsError,
    error: srcAccountsQueryError,
    refetch: refetchSrcAccounts,
  } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/admin/account-migration/accounts", srcCompanyId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/account-migration/accounts/${encodeURIComponent(srcCompanyId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load accounts (${res.status})`);
      }
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.accounts) ? body.accounts : [];
    },
    enabled: !!srcCompanyId,
  });

  const {
    data: pendingMigrationsResponse,
    isLoading: loadingPending,
    isError: pendingError,
    refetch: refetchPendingMigrations,
  } = useQuery<PendingMigration[]>({
    queryKey: ["/api/admin/account-migration/pending"],
    queryFn: async () => {
      const res = await fetch("/api/admin/account-migration/pending", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load active migrations (${res.status})`);
      }
      // Keep only well-formed rows: a malformed payload must not crash the page.
      const data: unknown = await res.json();
      return Array.isArray(data)
        ? (data.filter(
            (row) => row && typeof row === "object" && Array.isArray((row as PendingMigration).accounts)
          ) as PendingMigration[])
        : [];
    },
    staleTime: 0,
  });

  const pendingMigrations: PendingMigration[] = Array.isArray(pendingMigrationsResponse)
    ? pendingMigrationsResponse
    : [];

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/account-migration/preview", {
        accountIds: selectedAccountIds,
        srcCompanyId: parseInt(srcCompanyId),
        destCompanyId: parseInt(destCompanyId),
      });
      return res.json() as Promise<PreviewResult>;
    },
    onSuccess: (data) => setPreview(data),
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const executeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/account-migration/execute", {
        accountIds: selectedAccountIds,
        srcCompanyId: parseInt(srcCompanyId),
        destCompanyId: parseInt(destCompanyId),
      });
      return res.json() as Promise<ExecuteResult>;
    },
    onSuccess: (data) => {
      void refetchPendingMigrations();
      setConfirmOpen(false);
      setPreview(null);
      setSelectedAccountIds([]);
      setSrcCompanyId("");
      setDestCompanyId("");
      const count = data.accounts.length;
      toast({
        title: "Migration complete",
        description: `${count} account${count === 1 ? "" : "s"} moved with ${data.totalEntries} entries.`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      setConfirmOpen(false);
      toast({ title: "Migration failed", description: err.message, variant: "destructive" });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      if (!undoTarget) throw new Error("Select a migration to move back");
      const res = await apiRequest("POST", "/api/admin/account-migration/undo", {
        accounts: undoTarget.accounts.map((a) => ({
          accountId: a.accountId,
          originalCode: a.originalCode,
        })),
        movedVoucherIds: undoTarget.movedVoucherIds,
        srcCompanyId: undoTarget.srcCompanyId,
        destCompanyId: undoTarget.destCompanyId,
      });
      return res.json();
    },
    onSuccess: () => {
      const returnedCount = undoTarget?.accounts.length ?? 0;
      setUndoTarget(null);
      void refetchPendingMigrations();
      toast({
        title: "Account moved back",
        description: `${returnedCount} account${returnedCount === 1 ? "" : "s"} returned to the original company.`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Move back failed", description: err.message, variant: "destructive" });
    },
  });

  const srcCompany = companies.find((c) => String(c.id) === srcCompanyId);
  const destCompany = companies.find((c) => String(c.id) === destCompanyId);
  const canPreview =
    !!srcCompanyId && !!destCompanyId && selectedAccountIds.length > 0 && srcCompanyId !== destCompanyId;
  return {
    canPreview,
    companies,
    companiesError,
    confirmOpen,
    destCompany,
    destCompanyId,
    executeMutation,
    loadingCompanies,
    loadingPending,
    loadingSrcAccounts,
    pendingError,
    pendingMigrations,
    preview,
    previewMutation,
    refetchCompanies,
    refetchPendingMigrations,
    refetchSrcAccounts,
    selectedAccountIds,
    setConfirmOpen,
    setDestCompanyId,
    setPreview,
    setSelectedAccountIds,
    setSrcCompanyId,
    setUndoTarget,
    srcAccounts,
    srcAccountsError,
    srcAccountsQueryError,
    srcCompany,
    srcCompanyId,
    undoMutation,
    undoTarget,
  };
}
