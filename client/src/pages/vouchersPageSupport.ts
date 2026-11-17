// Extracted from ./Vouchers.tsx to keep that module under the source-size cap.
import type { Dispatch, SetStateAction } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ClientErrorLike } from "@/lib/clientError";
import type { useAppMode } from "@/contexts/AppModeContext";
import type { useToast } from "@/hooks/use-toast";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import type { getApiRequest } from "@/lib/factoryApi";
import type { AuthMe } from "@shared/apiTypes";

export type VoucherTab = "payment" | "receipt" | "journal" | "transfer" | "transferorder" | "adjustment" | "creditnote";

export const FACTORY_VOUCHER_HIDDEN_KEYS: Record<VoucherTab, string> = {
  payment: "hide_tab_vouchers_payment",
  receipt: "hide_tab_vouchers_receipt",
  journal: "hide_tab_vouchers_journal",
  transfer: "hide_tab_vouchers_transfer",
  transferorder: "hide_tab_vouchers_transferorder",
  adjustment: "hide_tab_vouchers_adjustment",
  creditnote: "hide_tab_vouchers_creditnote",
};
export const ALL_VOUCHER_TABS: readonly VoucherTab[] = [
  "payment",
  "receipt",
  "journal",
  "transfer",
  "transferorder",
  "adjustment",
  "creditnote",
];

export interface VouchersProps {
  posUser?: Pick<AuthMe, "assignedLocationId"> | null;
}

/** Sends an account statement for one month to the account's WhatsApp (ERP or Factory route by mode). */
export function useSendWaStatementMutation({
  appMode,
  modeApiRequest,
  toast,
  setWaPendingPrompt,
}: {
  appMode: ReturnType<typeof useAppMode>;
  modeApiRequest: ReturnType<typeof getApiRequest>;
  toast: ReturnType<typeof useToast>["toast"];
  setWaPendingPrompt: Dispatch<SetStateAction<WhatsAppPromptState>>;
}) {
  return useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      const url =
        appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const res = await modeApiRequest("POST", url, { month });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed to send WhatsApp");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Statement sent to WhatsApp" });
      setWaPendingPrompt(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "WhatsApp send failed", description: error.message, variant: "destructive" });
      setWaPendingPrompt(null);
    },
  });
}
