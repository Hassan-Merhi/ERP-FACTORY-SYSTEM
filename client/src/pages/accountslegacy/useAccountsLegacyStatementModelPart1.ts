// Extracted from ./useAccountsLegacyStatementModel.ts
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { type SubmitHandler } from "react-hook-form";
import { useReactToPrint } from "react-to-print";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { InsertBankAccount } from "@shared/schema";
import { WaRule, WaChat } from "../accounts/accountTypes";
import { useAccountsLegacyDialogsModel } from "./useAccountsLegacyDialogsModel";
import { DEFAULT_WA_RULE } from "./useAccountsLegacyModel";

export function useAccountsLegacyStatementModelPart1() {
  const d = useAccountsLegacyDialogsModel();

  const onBankSubmit: SubmitHandler<Omit<InsertBankAccount, "companyId">> = (data) => {
    if (d.bankToEdit) {
      d.updateBankMutation.mutate({ id: d.bankToEdit.id, ...data });
    } else {
      d.createBankMutation.mutate(data);
    }
  };

  const handleDeleteBankAccount = () => {
    if (d.bankToEdit) d.deleteBankMutation.mutate(d.bankToEdit.id);
  };

  const [filterCurrency, setFilterCurrency] = useState<"all" | "CFA">("all");
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const [exportLang, setExportLang] = useState<"en" | "fr" | "ar">("en");

  // ─── WhatsApp rule state ─────────────────────────────────────────────────
  const [waRuleDialogOpen, setWaRuleDialogOpen] = useState(false);
  const [waRuleDraft, setWaRuleDraft] = useState<WaRule>(DEFAULT_WA_RULE);
  const [waChatSearch, setWaChatSearch] = useState("");

  const selectedAccountIsLedger = !!d.selectedAccount?.accountId;
  const selectedAccountId = d.selectedAccount?.accountId ?? null;

  const { data: waChatsRaw = [], isLoading: waChatsLoading } = useQuery<WaChat[]>({
    queryKey: ["/api/whatsapp/chats/pos"],
    queryFn: async () => {
      const res = await fetch("/api/whatsapp/chats/pos", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000,
    enabled: waRuleDialogOpen,
  });

  const waRuleBase = d.appMode === "factory" ? "/api/factory/accounts" : "/api/accounts";
  const { data: waRule = null } = useQuery<WaRule | null>({
    queryKey: [waRuleBase, selectedAccountId, "whatsapp-rule"],
    queryFn: async () => {
      const res = await fetch(`${waRuleBase}/${selectedAccountId}/whatsapp-rule`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: selectedAccountIsLedger && !!selectedAccountId,
    staleTime: 30_000,
  });

  const filteredWaChats = useMemo(() => {
    if (!waChatSearch.trim()) return waChatsRaw;
    return waChatsRaw.filter((c) => searchAny(waChatSearch, c.name));
  }, [waChatsRaw, waChatSearch]);

  const openWaRuleDialog = () => {
    setWaRuleDraft(waRule ?? DEFAULT_WA_RULE);
    setWaChatSearch("");
    setWaRuleDialogOpen(true);
  };

  const saveWaRuleMutation = useMutation({
    mutationFn: async (rule: WaRule) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const res = await apiRequest("PUT", `${waRuleBase}/${selectedAccountId}/whatsapp-rule`, rule);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      d.toast({ title: "WhatsApp rule saved" });
      setWaRuleDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: [waRuleBase, selectedAccountId, "whatsapp-rule"] });
    },
    onError: (err: ClientErrorLike) => {
      d.toast({ title: "Save failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const sendWaStatementMutation = useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const url =
        d.appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const res = await apiRequest("POST", url, { month });
      if (!res.ok) throw new Error((await res.json()).message || "Send failed");
      return res.json();
    },
    onSuccess: () => {
      d.toast({ title: "Statement sent to WhatsApp" });
    },
    onError: (err: ClientErrorLike) => {
      d.toast({ title: "WhatsApp send failed", description: err?.message, variant: "destructive" });
    },
  });

  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: d.selectedAccount ? `Statement - ${d.selectedAccount.name}` : "Account Statement",
  });
  return {
    d,
    onBankSubmit,
    handleDeleteBankAccount,
    filterCurrency,
    setFilterCurrency,
    currentUser,
    exportLang,
    setExportLang,
    waRuleDialogOpen,
    setWaRuleDialogOpen,
    waRuleDraft,
    setWaRuleDraft,
    waChatSearch,
    setWaChatSearch,
    selectedAccountIsLedger,
    waChatsLoading,
    waRule,
    filteredWaChats,
    openWaRuleDialog,
    saveWaRuleMutation,
    sendWaStatementMutation,
    printRef,
    handlePrint,
  };
}
