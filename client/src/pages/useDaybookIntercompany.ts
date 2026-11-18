// Extracted from ./Daybook.tsx to keep that module under the source-size cap.
import type { Dispatch, SetStateAction } from "react";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateCompanyApiFamily } from "@/lib/frontendDataArchitecture";
import { isVoucherMutationBlocked } from "@/lib/migratedVoucherGuard";
import type { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { useToast } from "@/hooks/use-toast";
import type { DaybookRow, Voucher } from "./daybook/types";
import { voucherEditPath } from "./daybook/voucherEditRoute";

/** Ids of the displayed Daybook vouchers that belong to an intercompany container trade. */
export function useDaybookLinkedVoucherIds(companyId: number | undefined, displayedRows: DaybookRow[]) {
  const daybookVoucherIds = useMemo(
    () =>
      displayedRows
        .filter((r) => r._type === "voucher" && r.data.id > 0)
        .map((r) => r.data.id)
        .slice(0, 100),
    [displayedRows]
  );
  const { data: linkedDaybookVouchers } = useQuery<{
    linked: Record<number, { tradeId: number; version: number }>;
  }>({
    queryKey: ["/api/intercompany-container-trading/daybook-linked-vouchers", companyId, daybookVoucherIds.join(",")],
    enabled: !!companyId && daybookVoucherIds.length > 0,
    queryFn: async () => {
      const response = await fetch(
        "/api/intercompany-container-trading/daybook-linked-vouchers?ids=" + daybookVoucherIds.join(","),
        { credentials: "include" }
      );
      if (!response.ok) {
        const issue = await response.json().catch(() => ({}));
        throw new Error(issue.message || "Cannot verify intercompany voucher links");
      }
      return response.json();
    },
    staleTime: 0,
  });
  return useMemo(() => new Set(Object.keys(linkedDaybookVouchers?.linked ?? {}).map(Number)), [linkedDaybookVouchers]);
}

/**
 * Daybook voucher delete. Intercompany-linked vouchers are deleted in both
 * companies through the linked endpoint; ownership is re-checked at delete time.
 */
export function useDaybookDeleteMutation({
  recordChanges,
  voucherToDelete,
  companyId,
  refreshBalances,
  toast,
  setDeleteDialogOpen,
}: {
  recordChanges: ReturnType<typeof useExistingRecordChangeAccess>;
  voucherToDelete: Voucher | null;
  companyId: number | undefined;
  refreshBalances: () => void;
  toast: ReturnType<typeof useToast>["toast"];
  setDeleteDialogOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      // Refresh ownership at deletion time. Never silently fall back to a
      // single-company voucher delete when link lookup is stale or fails.
      const linkResponse = await fetch("/api/intercompany-container-trading/daybook-linked-vouchers?ids=" + id, {
        credentials: "include",
      });
      if (!linkResponse.ok) {
        const issue = await linkResponse.json().catch(() => ({}));
        throw new Error(issue.message || "Cannot verify whether this voucher belongs to another company");
      }
      const currentLinks = (await linkResponse.json()) as {
        linked: Record<number, { tradeId: number; version: number }>;
      };
      const linked = currentLinks.linked[id];
      if (linked) {
        await apiRequest("POST", "/api/intercompany-container-trading/daybook-voucher/" + id + "/delete-linked", {
          expectedVersion: linked.version,
          confirmDeleteBothCompanies: true,
        });
        return { linked: true };
      }
      if (voucherToDelete && isVoucherMutationBlocked(voucherToDelete)) {
        throw new Error("Locked voucher cannot be deleted individually; refresh and review.");
      }
      await apiRequest("DELETE", `/api/vouchers/${id}`);
      return { linked: false };
    },
    onSuccess: ({ linked }) => {
      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", companyId);
      for (const key of [
        "/api/intercompany-container-trading/daybook-linked-vouchers",
        "/api/intercompany-container-trading/lifecycle",
        "/api/purchase-orders",
        "/api/containers",
        "/api/suppliers",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      refreshBalances();
      toast({
        title: "Deleted",
        description: linked
          ? "Linked POs and original vouchers deleted in both companies. No reversals created."
          : "Voucher deleted",
      });
      setDeleteDialogOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Deletion refused", description: error.message, variant: "destructive" });
      setDeleteDialogOpen(false);
    },
  });
}

/** Daybook edit action: Purchase vouchers open their container; other types open their voucher editor. */
export function openDaybookVoucherEditor(
  v: Voucher,
  {
    vouchersBase,
    navigate,
    toast,
  }: { vouchersBase: string; navigate: (path: string) => void; toast: ReturnType<typeof useToast>["toast"] }
) {
  // Purchase lock icon → navigate directly to the container page for that PO
  if (v.voucherType === "Purchase") {
    const fallback = voucherEditPath(v, vouchersBase)!;
    fetch(`/api/vouchers/${v.id}/view-entries`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const po = data && !Array.isArray(data) ? data.purchaseOrder : null;
        navigate(po?.containerId ? `/containers/${po.containerId}` : fallback);
      })
      .catch(() => navigate(fallback));
    return;
  }
  const path = voucherEditPath(v, vouchersBase);
  if (path) navigate(path);
  else toast({ title: "Info", description: `Editing ${v.voucherType} not supported.`, variant: "destructive" });
}
