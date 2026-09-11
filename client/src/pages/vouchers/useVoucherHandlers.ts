import { getErrorDetails } from "@shared/errorUtils";
import type { Account } from "@/components/AccountSidebar";
import { focusScopedTestId } from "@/lib/scopedFocus";
import type { QueryClient } from "@tanstack/react-query";
import type { UseFieldArrayAppend, UseFormReturn } from "react-hook-form";
import type { VoucherFormData } from "./voucherTypes";
import { useToast } from "@/hooks/use-toast";

type ToastFn = ReturnType<typeof useToast>["toast"];

interface UseVoucherHandlersProps {
  form: UseFormReturn<VoucherFormData>;
  append: UseFieldArrayAppend<VoucherFormData, "entries">;
  activeRowIndex: number | null;
  setActiveRowIndex: (i: number | null) => void;
  sidebarAccounts: Account[];
  selectedCompany: { id: number } | null;
  setIsAutoCreating: (v: boolean) => void;
  queryClient: QueryClient;
  toast: ToastFn;
  setSelectedAccountId: (v: number | null) => void;
  setSelectedAccountType: (v: string | null) => void;
  setSidebarSearchValue: (v: string) => void;
  setSidebarHighlightedIndex: (v: number) => void;
}

export function useVoucherHandlers({
  form,
  append,
  activeRowIndex,
  setActiveRowIndex,
  sidebarAccounts,
  selectedCompany,
  setIsAutoCreating,
  queryClient,
  toast,
  setSelectedAccountId,
  setSelectedAccountType,
  setSidebarSearchValue: _setSidebarSearchValue,
  setSidebarHighlightedIndex: _setSidebarHighlightedIndex,
}: UseVoucherHandlersProps) {
  const handleSidebarAccountSelect = async (account: Account) => {
    const currentEntries = form.getValues("entries");
    let targetRowIndex: number;

    if (activeRowIndex !== null && activeRowIndex < currentEntries.length) {
      targetRowIndex = activeRowIndex;
      form.setValue(`entries.${activeRowIndex}.accountType`, account.type);
      form.setValue(`entries.${activeRowIndex}.accountId`, account.id);
      form.setValue(`entries.${activeRowIndex}.accountName`, account.name);
    } else {
      const emptyEntryIndex = currentEntries.findIndex((entry) => entry.accountId === 0 || !entry.accountName);
      if (emptyEntryIndex >= 0) {
        targetRowIndex = emptyEntryIndex;
        form.setValue(`entries.${emptyEntryIndex}.accountType`, account.type);
        form.setValue(`entries.${emptyEntryIndex}.accountId`, account.id);
        form.setValue(`entries.${emptyEntryIndex}.accountName`, account.name);
      } else {
        targetRowIndex = currentEntries.length;
        append({ accountType: account.type, accountId: account.id, accountName: account.name, amount: "" });
      }
    }

    focusScopedTestId(`input-amount-${targetRowIndex}`, { select: true });
    setSelectedAccountId(account.id);
    setSelectedAccountType(account.type);
    setActiveRowIndex(targetRowIndex);
  };

  const handleAmountCommit = async (_rowIndex: number) => {
    // Do not clear the active row or account search on amount commit/blur.
    // The amount input blurs naturally when the user clicks either the row account
    // field or the right-side account search. Clearing search state here raced the
    // new input event, erased what the user had just typed, and reset the sidebar
    // back to the full account list. Enter/Tab already move focus themselves, and
    // the next row's onFocus updates activeRowIndex, so no forced refocus is needed.
    setSelectedAccountId(null);
    setSelectedAccountType(null);
  };

  const handleAutoCreateAccount = async (name: string): Promise<Account | null> => {
    if (!selectedCompany?.id || !name.trim()) return null;
    setIsAutoCreating(true);
    try {
      const normalizedName = name.trim().toLowerCase();
      const existingAccount = sidebarAccounts.find((account) => account.name.toLowerCase() === normalizedName);
      if (existingAccount) return existingAccount;

      const payload = { name: name.trim(), accountType: "Indirect Expense", companyId: selectedCompany.id };
      const response = await fetch("/api/ledger-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create account");
      }
      const newAccount = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar", selectedCompany.id] });
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts", selectedCompany.id] });
      toast({ title: "Account created", description: `"${newAccount.name}" created as Indirect Expense.` });
      return {
        id: newAccount.id,
        name: newAccount.name,
        type: "ledger" as const,
        code: newAccount.code || "",
        balance: 0,
      };
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: getErrorDetails(error).message || "Failed to create account",
      });
      return null;
    } finally {
      setIsAutoCreating(false);
    }
  };

  return { handleSidebarAccountSelect, handleAmountCommit, handleAutoCreateAccount };
}
