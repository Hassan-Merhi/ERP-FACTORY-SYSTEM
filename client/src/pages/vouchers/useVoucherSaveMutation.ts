/**
 * Payment / Receipt voucher save mutation of pages/Vouchers.tsx (split out of
 * the page): posts or edits the voucher, or settles an FX wallet payment, then
 * refreshes the dependent queries, the WhatsApp statement prompt and the form
 * draft. An offline-queued save shows a synthetic PENDING voucher row instead.
 */
import type { Dispatch, SetStateAction } from "react";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import type { UseFormReturn } from "react-hook-form";
import type { ClientErrorLike } from "@/lib/clientError";
import { apiRequestPrivileged, queryClient, invalidateContainerLandedCostQueries } from "@/lib/queryClient";
import { attachAccountingRequestIdentity, releaseAccountingRequestIdentity } from "@/lib/accountingRequestIdentity";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import type { IntercompanyVoucherMirror } from "./useNormalIntercompanyVoucher";
import { resolveWhatsAppPrompt, type WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import type { getApiRequest } from "@/lib/factoryApi";
import type { useToast } from "@/hooks/use-toast";
import type { useVoucherFxWalletPayment } from "@/pages/vouchers/useVoucherFxWalletPayment";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";

type FxWalletPayment = ReturnType<typeof useVoucherFxWalletPayment>;
type WalletPaymentContext = Parameters<FxWalletPayment["postWalletPayment"]>[1];
type VoucherSubmission = VoucherFormData & { intercompanyMirror?: IntercompanyVoucherMirror };

export function useVoucherSaveMutation({
  activeTab,
  voucherIdToEdit,
  isWalletPayment,
  postWalletPayment,
  resetWalletPayment,
  selectedCurrency,
  voucherEffectiveDate,
  modeApiRequest,
  paymentPostingCurrency,
  paymentPostingRate,
  paymentAccountType,
  paymentAccountId,
  selectedCompany,
  modePrefix,
  setLocation,
  form,
  toast,
  setWaPendingPrompt,
  discardPaymentDraft,
}: {
  activeTab: string;
  voucherIdToEdit: number | null;
  isWalletPayment: boolean;
  postWalletPayment: FxWalletPayment["postWalletPayment"];
  resetWalletPayment: FxWalletPayment["resetWalletPayment"];
  selectedCurrency: WalletPaymentContext["selectedCurrency"];
  voucherEffectiveDate: string;
  modeApiRequest: ReturnType<typeof getApiRequest>;
  paymentPostingCurrency: string;
  paymentPostingRate: number | null | undefined;
  paymentAccountType: string;
  paymentAccountId: number;
  selectedCompany: { id: number } | null | undefined;
  modePrefix: string;
  setLocation: (path: string) => void;
  form: UseFormReturn<VoucherFormData>;
  toast: ReturnType<typeof useToast>["toast"];
  setWaPendingPrompt: Dispatch<SetStateAction<WhatsAppPromptState>>;
  discardPaymentDraft: () => void;
}) {
  return useMutation({
    mutationFn: async (formData: VoucherSubmission) => {
      if (isWalletPayment) {
        return postWalletPayment(formData, { selectedCurrency, voucherEffectiveDate, modeApiRequest });
      }
      const voucherType = activeTab === "payment" ? "Payment" : "Receipt";
      const isEditMode = !!voucherIdToEdit;
      const autoDesc = formData.notes?.trim()
        ? formData.notes.trim()
        : `${voucherType} (${formData.paymentAccountName || "—"})`;
      const payload = {
        voucherType,
        voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
        paymentAccountType: formData.paymentAccountType,
        paymentAccountId: formData.paymentAccountId,
        paymentAccountName: formData.paymentAccountName,
        paymentAccountNarration: formData.paymentAccountNarration,
        entries: formData.entries,
        notes: autoDesc,
        optional: formData.optional,
        currency: paymentPostingCurrency,
        exchangeRate: paymentPostingRate ? paymentPostingRate.toString() : undefined,
        effectiveDate: voucherEffectiveDate || null,
      };
      if (formData.intercompanyMirror) {
        if (isEditMode)
          throw new Error("Paired vouchers must be reversed together; they cannot be edited individually.");
        // Do not queue the two-company bank/cash movement offline. Preserve a
        // stable request identity across an uncertain network outcome, and let
        // the server's existing paired-payment idempotency reject duplicates.
        const endpoint = "/api/vouchers/payment-receipt";
        const mirroredPayload = attachAccountingRequestIdentity("POST", endpoint, {
          ...payload,
          intercompanyMirror: formData.intercompanyMirror,
        });
        const res = await apiRequestPrivileged("POST", endpoint, mirroredPayload);
        releaseAccountingRequestIdentity("POST", endpoint, mirroredPayload, true);
        return await res.json();
      }
      if (isEditMode) {
        const res = await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}/payment-receipt`, payload);
        return await res.json();
      } else {
        const res = await modeApiRequest("POST", "/api/vouchers/payment-receipt", payload);
        return await res.json();
      }
    },
    onSuccess: async (data) => {
      const isEditMode = !!voucherIdToEdit;
      const mirrored = (data as { intercompanyMirrored?: boolean; paymentId?: number }).intercompanyMirrored === true;
      toast({
        title: mirrored ? "Intercompany vouchers posted together" : "Success",
        description: mirrored
          ? "Both the linked company Receipt and Payment were committed; no second standalone voucher was created."
          : `${activeTab === "payment" ? "Payment" : "Receipt"} voucher ${isEditMode ? "updated" : "created"} successfully`,
      });
      if (mirrored) {
        for (const family of [
          "/api/vouchers",
          "/api/accounts",
          "/api/bank-accounts",
          "/api/ledger-accounts",
          "/api/suppliers",
          "/api/daybook",
          "/api/net-position",
          "/api/intercompany-container-trading/payments",
        ]) {
          void invalidateApiFamily(queryClient, family);
        }
      }
      const waPrompt = resolveWhatsAppPrompt(data);
      if (waPrompt) setWaPendingPrompt(waPrompt);
      discardPaymentDraft();
      resetWalletPayment();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts", paymentAccountType, paymentAccountId, "balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      if (isEditMode) {
        invalidateContainerLandedCostQueries();
        setLocation(`${modePrefix}/daybook`);
      } else {
        form.reset({
          paymentAccountType: "ledger",
          paymentAccountId: 0,
          paymentAccountName: "",
          voucherDate: new Date(),
          entries: [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
          paymentAccountNarration: "",
          notes: "",
          optional: false,
        });
      }
    },
    onError: (error: ClientErrorLike, formData: VoucherFormData) => {
      if (error.name === "OfflineQueued") {
        const voucherType = activeTab === "payment" ? "Payment" : "Receipt";
        const syntheticVoucher = {
          id: -Date.now(),
          voucherNumber: "PENDING",
          voucherType,
          voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
          description: formData.notes || `${voucherType} (pending sync)`,
          totalAmount: formData.entries
            .filter((e) => parseFloat(e.amount || "0") > 0)
            .reduce((sum: number, e) => sum + parseFloat(e.amount || "0"), 0)
            .toFixed(2),
          optional: formData.optional || false,
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueriesData({ queryKey: ["/api/vouchers"] }, (old) =>
          Array.isArray(old) ? [syntheticVoucher, ...old] : old
        );
        discardPaymentDraft();
        form.reset({
          paymentAccountType: "ledger",
          paymentAccountId: 0,
          paymentAccountName: "",
          voucherDate: new Date(),
          entries: [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
          paymentAccountNarration: "",
          notes: "",
          optional: false,
        });
        return;
      }
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || `Failed to ${voucherIdToEdit ? "update" : "create"} voucher`,
        variant: "destructive",
      });
    },
  });
}
