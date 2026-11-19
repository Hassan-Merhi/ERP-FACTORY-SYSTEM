// Extracted from ./FactoryLoadingDispatchPostingPanel.tsx
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

interface Preview {
  status: string;
  canEdit: boolean;
  chargeFingerprint: string;
  source: {
    baleCount: number;
    goodsSubtotal: string;
    totalWeightKg: string;
    sourceFingerprint: string;
    closureRevision: number;
  } | null;
  totals: {
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    internalExpenseTotal: string;
    customerTotal: string;
  } | null;
  sourceError: { message: string } | null;
}

interface Posting {
  revision: number;
  kind: string;
  amount: string;
  voucherIds: number[];
  postedAt: string;
  reason?: string | null;
}

interface History {
  financial: {
    id: number;
    status: string;
    postingRevision: number;
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    customerTotal: string;
    postedAt: string | null;
    valuationDate: string | null;
  } | null;
  postings: Posting[];
  events: Array<{ eventType: string; actorUsername: string; createdAt: string; reason?: string | null }>;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || "Could not load financial status");
  return data as T;
}

export const roleCanPost = (role: string) => ["admin", "owner", "developer"].includes(role.trim().toLowerCase());

export const errorText = (error: unknown) => (error instanceof Error ? error.message : "Posting failed");

export function useFactoryLoadingDispatchPostingPanelState({
  orderId,
  dispatchId,
  companyId,
  status,
  role,
}: Pick<Props, "orderId" | "dispatchId" | "companyId" | "status" | "role">) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"post" | "reverse" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const previewUrl = base + "/financial-preview";
  const historyUrl = base + "/financial-history";
  const enabled = Boolean(companyId) && roleCanPost(role) && status === "CLOSED";
  const preview = useQuery<Preview>({
    queryKey: companyQueryKey(previewUrl, companyId),
    queryFn: () => read<Preview>(previewUrl),
    enabled,
    refetchInterval: mode ? false : 15000,
  });
  const history = useQuery<History>({
    queryKey: companyQueryKey(historyUrl, companyId),
    queryFn: () => read<History>(historyUrl),
    enabled,
    refetchInterval: mode ? false : 15000,
  });
  const financialStatus = history.data?.financial?.status ?? preview.data?.status ?? "DRAFT";
  const editable = Boolean(preview.data?.canEdit && preview.data.source && preview.data.totals);
  const canPost = enabled && editable && (financialStatus === "DRAFT" || financialStatus === "REVERSED");
  const canReverse = enabled && financialStatus === "POSTED";
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(previewUrl, companyId) });
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(historyUrl, companyId) });
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!mode || !confirmed) throw new Error("Explicit confirmation required");
      if (mode === "post") {
        if (!preview.data?.source || !preview.data.totals || !canPost) {
          throw new Error("Refresh the signed preview before financial finalization");
        }
        const response = await apiRequest("POST", base + "/financial-finalize", {
          confirm: true,
          sourceFingerprint: preview.data.source.sourceFingerprint,
          chargeFingerprint: preview.data.chargeFingerprint,
        });
        return response.json();
      }
      if (!canReverse || reason.trim().length < 10) throw new Error("An approved reversal reason is required");
      const response = await apiRequest("POST", base + "/financial-reverse", { confirm: true, reason: reason.trim() });
      return response.json();
    },
    onSuccess: () => {
      const action = mode;
      setMode(null);
      setConfirmed(false);
      setReason("");
      void queryClient.invalidateQueries();
      toast({
        title: action === "post" ? "Trip financially finalized" : "Trip financial posting reversed",
        description:
          action === "post"
            ? "Customer receivable and charge vouchers are posted. One final invoice will be created later."
            : "The original vouchers remain in history, with reversing journals.",
      });
    },
    onError: (e) => {
      refresh();
      toast({ title: "Financial action refused", description: errorText(e), variant: "destructive" });
    },
  });
  const submitDisabled =
    mutation.isPending ||
    !confirmed ||
    (mode === "post" ? !canPost : !canReverse || reason.trim().length < 10 || reason.trim().length > 1000);

  const [exportingInvoice, setExportingInvoice] = useState(false);
  const exportTripInvoice = async () => {
    setExportingInvoice(true);
    try {
      const url =
        "/api/factory/customer-orders/" +
        orderId +
        "/loading-dispatches/order-overview/trips/" +
        dispatchId +
        "/invoice.xlsx";
      await downloadFromUrl(url, {
        fileName: exportFileName("factory trip invoice " + dispatchId, "xlsx"),
        preferLocalFileName: true,
      });
      toast({ title: "Excel trip invoice downloaded" });
    } catch (error) {
      toast({ title: "Export failed", description: errorText(error), variant: "destructive" });
    } finally {
      setExportingInvoice(false);
    }
  };
  const existingPostings = history.data?.postings ?? [];
  return {
    setMode,
    mode,
    setConfirmed,
    confirmed,
    setReason,
    reason,
    enabled,
    preview,
    history,
    financialStatus,
    canPost,
    mutation,
    submitDisabled,
    exportingInvoice,
    exportTripInvoice,
    existingPostings,
  };
}
