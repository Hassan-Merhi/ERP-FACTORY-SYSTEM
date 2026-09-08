import { useRef } from "react";
import { UseFormReturn } from "react-hook-form";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";

/** One entry row, taken from the voucher form's schema rather than restated. */
export type VoucherEntry = VoucherFormData["entries"][number];

interface UseVoucherEntriesProps {
  form: UseFormReturn<VoucherFormData>;
}

export function useVoucherEntries({ form }: UseVoucherEntriesProps) {
  const amountInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const entries = form.watch("entries") || [];

  const total = entries.reduce((sum: number, entry: VoucherEntry) => {
    const amount = parseFloat(entry.amount);
    return sum + (isNaN(amount) ? 0 : amount);
  }, 0);

  const addEmptyEntry = () => {
    const currentEntries = form.getValues("entries");
    form.setValue("entries", [
      ...currentEntries,
      {
        accountType: "ledger",
        accountId: 0,
        accountName: "",
        amount: "",
      },
    ]);
  };

  const addEntryFromSidebar = (accountType: VoucherEntry["accountType"], accountId: number, accountName: string) => {
    const currentEntries = form.getValues("entries");

    const emptyIndex = currentEntries.findIndex((e: VoucherEntry) => !e.accountId || e.accountId === 0);

    if (emptyIndex >= 0) {
      form.setValue(`entries.${emptyIndex}.accountType`, accountType);
      form.setValue(`entries.${emptyIndex}.accountId`, accountId);
      form.setValue(`entries.${emptyIndex}.accountName`, accountName);

      setTimeout(() => {
        focusAmount(emptyIndex);
      }, 50);
    } else {
      const newIndex = currentEntries.length;
      const currentFormEntries = form.getValues("entries");
      form.setValue("entries", [
        ...currentFormEntries,
        {
          accountType,
          accountId,
          accountName,
          amount: "",
        },
      ]);

      setTimeout(() => {
        focusAmount(newIndex);
      }, 50);
    }
  };

  const focusAmount = (index: number) => {
    const input = amountInputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  };

  const resetForNextEntry = () => {
    const currentEntries = form.getValues("entries");

    const hasEmpty = currentEntries.some((e: VoucherEntry) => !e.accountId || e.accountId === 0);

    if (!hasEmpty) {
      const _newIndex = currentEntries.length;
      form.setValue("entries", [
        ...currentEntries,
        {
          accountType: "ledger",
          accountId: 0,
          accountName: "",
          amount: "",
        },
      ]);
    }
  };

  const removeEntry = (index: number) => {
    const currentEntries = form.getValues("entries");
    const filtered = currentEntries.filter((_: unknown, i: number) => i !== index);

    if (filtered.length === 0) {
      form.setValue("entries", [
        {
          accountType: "ledger",
          accountId: 0,
          accountName: "",
          amount: "",
        },
      ]);
    } else {
      form.setValue("entries", filtered);
    }
  };

  return {
    entries,
    total,
    amountInputRefs,
    addEmptyEntry,
    addEntryFromSidebar,
    focusAmount,
    resetForNextEntry,
    removeEntry,
  };
}
