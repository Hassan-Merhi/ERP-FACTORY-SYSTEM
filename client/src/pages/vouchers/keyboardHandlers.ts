import type React from "react";
import { focusScopedTestId } from "@/lib/scopedFocus";
import type { VoucherFormData } from "./voucherTypes";

export function handlePaymentKeyDown(
  e: React.KeyboardEvent,
  rowIndex: number,
  fieldName: "account" | "amount",
  fieldsLength: number,
  append: (value: VoucherFormData["entries"][number]) => void
): void {
  const isLastRow = rowIndex === fieldsLength - 1;
  const anchor = e.currentTarget as Element;

  if (fieldName === "account" && e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    focusScopedTestId(`input-amount-${rowIndex}`, { select: true, delay: 50, anchor });
  }

  if (fieldName === "amount") {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowIndex > 0) focusScopedTestId(`input-amount-${rowIndex - 1}`, { select: true, delay: 50, anchor });
      return;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowIndex < fieldsLength - 1)
        focusScopedTestId(`input-amount-${rowIndex + 1}`, { select: true, delay: 50, anchor });
      return;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusScopedTestId(`input-account-${rowIndex}`, { delay: 50, anchor });
      return;
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (rowIndex < fieldsLength - 1) focusScopedTestId(`input-account-${rowIndex + 1}`, { delay: 50, anchor });
      return;
    }
  }

  if (fieldName === "amount" && ((e.key === "Tab" && !e.shiftKey) || e.key === "Enter")) {
    e.preventDefault();
    if (isLastRow) append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" });
    focusScopedTestId(`input-account-${rowIndex + 1}`, { delay: 100, anchor });
  }
}
