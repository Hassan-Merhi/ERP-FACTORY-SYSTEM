// Extracted from ./useJournalFormModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { resolveWhatsAppPrompt } from "@/lib/whatsapp-prompt";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import type { JournalFormData } from "./types";
import { confirmAction } from "@/components/ConfirmHost";
import {
  emptyJournal,
  errorMessage,
  isGloballyHandled,
  isOfflineQueued,
  useJournalFormModelPart1,
} from "./useJournalFormModelPart1";

export function useJournalFormModelPart3({
  appMode,
  discardJournalDraft,
  formatAmount,
  journalEffectiveDate,
  journalForm,
  modeApiRequest,
  modePrefix,
  postingRate,
  selectedCompany,
  selectedCurrency,
  setLocation,
  setWaPendingPrompt,
  toast,
  totalCredit,
  totalDebit,
  voucherIdToEdit,
}: Pick<
  Awaited<ReturnType<typeof useJournalFormModelPart1>>,
  | "appMode"
  | "discardJournalDraft"
  | "formatAmount"
  | "journalEffectiveDate"
  | "journalForm"
  | "modeApiRequest"
  | "modePrefix"
  | "postingRate"
  | "selectedCompany"
  | "selectedCurrency"
  | "setLocation"
  | "setWaPendingPrompt"
  | "toast"
  | "totalCredit"
  | "totalDebit"
  | "voucherIdToEdit"
>) {
  const journalMutation = useMutation({
    mutationFn: async (formData: JournalFormData) => {
      const payload = {
        voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
        entries: formData.entries.filter((entry) => entry.accountId > 0),
        notes: formData.notes,
        optional: formData.optional,
        currency: selectedCurrency,
        exchangeRate: postingRate ? postingRate.toString() : undefined,
        effectiveDate: journalEffectiveDate || null,
      };
      if (voucherIdToEdit) {
        return (await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}/journal`, payload)).json();
      }
      try {
        return (await modeApiRequest("POST", "/api/vouchers/journal", payload)).json();
      } catch (error: unknown) {
        // Phase 22 (B), D6: a Golden Coast owner withdrawal is posted as its
        // template only when the user confirms it (OK); Cancel posts it as entered.
        if ((error as { code?: unknown } | null)?.code !== "GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM") throw error;
        const useTemplate = await confirmAction({
          title: "Post as owner withdrawal template?",
          description: errorMessage(error, ""),
          confirmText: "Use template",
          cancelText: "Post as entered",
        });
        const confirmed = { ...payload, goldenCoastOwnerWithdrawalTemplate: useTemplate };
        return (await modeApiRequest("POST", "/api/vouchers/journal", confirmed)).json();
      }
    },
    onSuccess: async (data: unknown) => {
      const editing = !!voucherIdToEdit;
      toast({ title: "Saved", description: `Journal voucher ${editing ? "updated" : "created"} successfully` });
      const prompt = resolveWhatsAppPrompt(data);
      if (prompt) setWaPendingPrompt(prompt);
      discardJournalDraft();
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customers/") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      if (editing) setLocation(`${modePrefix}/daybook`);
      else journalForm.reset(emptyJournal());
    },
    onError: (error: unknown, formData: JournalFormData) => {
      if (isOfflineQueued(error)) {
        const syntheticVoucher = {
          id: -Date.now(),
          voucherNumber: "PENDING",
          voucherType: "Journal",
          voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
          description: formData.notes || "Journal (pending sync)",
          totalAmount: formData.entries
            .filter((entry) => entry.type === "DR" && parseFloat(entry.amount || "0") > 0)
            .reduce((sum, entry) => sum + parseFloat(entry.amount || "0"), 0)
            .toFixed(2),
          optional: formData.optional || false,
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueriesData({ queryKey: ["/api/vouchers"] }, (old: unknown) =>
          Array.isArray(old) ? [syntheticVoucher, ...old] : old
        );
        discardJournalDraft();
        journalForm.reset(emptyJournal());
        return;
      }
      if (isGloballyHandled(error)) return;
      toast({
        title: "Save failed",
        description: errorMessage(error, `Failed to ${voucherIdToEdit ? "update" : "create"} journal voucher`),
        variant: "destructive",
      });
    },
  });

  const sendWaStatementMutation = useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      const url =
        appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const response = await modeApiRequest("POST", url, { month });
      const json = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(json.message || "Failed to send WhatsApp");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Statement sent to WhatsApp" });
      setWaPendingPrompt(null);
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "WhatsApp send failed",
        description: errorMessage(error, "Failed to send WhatsApp"),
        variant: "destructive",
      });
      setWaPendingPrompt(null);
    },
  });

  const handleExportJournalVoucher = async (detailed: boolean) => {
    const formData = journalForm.getValues();
    const voucherDate = formData.voucherDate
      ? format(formData.voucherDate, "yyyy-MM-dd")
      : format(new Date(), "yyyy-MM-dd");
    const validEntries = formData.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount) > 0);
    if (!validEntries.length) {
      toast({
        title: "No data to export",
        description: "Add at least one entry before exporting.",
        variant: "destructive",
      });
      return;
    }
    if (detailed) {
      const worksheet = utils.json_to_sheet(
        validEntries.map((entry) => ({
          "Voucher Type": "Journal",
          Date: voucherDate,
          "DR/CR": entry.type,
          Account: entry.accountName || "",
          "Account Type": entry.accountType || "",
          Amount: parseFloat(entry.amount).toFixed(2),
          Notes: formData.notes || "",
          Optional: formData.optional ? "Yes" : "No",
        }))
      );
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Journal Detailed");
      const fileName = exportFileName("journal voucher detailed", "xlsx", { date: voucherDate });
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} entries.` });
      return;
    }
    const totalDr = validEntries
      .filter((entry) => entry.type === "DR")
      .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0);
    const totalCr = validEntries
      .filter((entry) => entry.type === "CR")
      .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0);
    const worksheet = utils.json_to_sheet([
      {
        "Voucher Type": "Journal",
        Date: voucherDate,
        "Total Debit": totalDr.toFixed(2),
        "Total Credit": totalCr.toFixed(2),
        "Number of Entries": validEntries.length,
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      },
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Journal Summary");
    const fileName = exportFileName("journal voucher summary", "xlsx", { date: voucherDate });
    await writeFile(workbook, fileName);
    toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
  };

  const onJournalSubmit = async (data: JournalFormData) => {
    const validEntries = data.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount) > 0);
    if (!validEntries.length) {
      toast({ title: "Validation Error", description: "Please add at least one valid entry", variant: "destructive" });
      return;
    }
    if (!validEntries.some((entry) => entry.type === "DR") || !validEntries.some((entry) => entry.type === "CR")) {
      toast({
        title: "Validation Error",
        description: "Journal must have both DR (debit) and CR (credit) entries",
        variant: "destructive",
      });
      return;
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      toast({
        title: "Validation Error",
        description: `Debits (${formatAmount(totalDebit)}) must equal Credits (${formatAmount(totalCredit)})`,
        variant: "destructive",
      });
      return;
    }
    if (selectedCurrency === "ZMW" && (!postingRate || !Number.isFinite(postingRate) || postingRate <= 0)) {
      toast({
        title: "Approved historical USD/ZMW rate required",
        description: "Select a voucher date with an approved exchange rate before posting or editing.",
        variant: "destructive",
      });
      return;
    }
    journalMutation.mutate(data);
  };
  return { handleExportJournalVoucher, journalMutation, onJournalSubmit, sendWaStatementMutation };
}
