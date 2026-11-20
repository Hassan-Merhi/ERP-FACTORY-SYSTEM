import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { RetailPaymentDraft } from "./retailPosTypes";

export interface RetailPaymentAccounts {
  ledgers: Array<{ id: number; code: string; name: string; accountType: string }>;
  banks: Array<{ id: number; code: string; name: string }>;
}

export function paymentAccountValue(payment: RetailPaymentDraft): string {
  if (payment.method === "credit") return "credit";
  if (payment.bankAccountId) return `bank:${payment.bankAccountId}`;
  if (payment.ledgerAccountId) return `ledger:${payment.ledgerAccountId}`;
  return "";
}

export function paymentFromAccount(
  selection: string,
  amount: number,
  accounts: RetailPaymentAccounts
): RetailPaymentDraft {
  if (selection === "credit") return { method: "credit", amount, tenderedAmount: null };
  const [kind, rawId] = selection.split(":");
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Select a valid payment account");
  if (kind === "ledger") {
    const account = accounts.ledgers.find((entry) => entry.id === id);
    if (!account) throw new Error("The selected ledger account is not available");
    const method = account.accountType === "Cash" ? "cash" : "bank";
    return { method, amount, tenderedAmount: method === "cash" ? amount : null, ledgerAccountId: id };
  }
  if (kind === "bank" && accounts.banks.some((entry) => entry.id === id)) {
    return { method: "bank", amount, tenderedAmount: null, bankAccountId: id };
  }
  throw new Error("Select a valid payment account");
}

/**
 * Retail tender account chooser. Cash/bank ledger and bank account identifiers
 * are namespaced to avoid collisions. Customer credit is an explicit tender
 * method, not a posting account; the caller retains credit eligibility rules.
 */
export function RetailPaymentAccountPicker({
  accounts,
  value,
  onValueChange,
  allowCredit = false,
  customerName,
  id,
  testId,
  className,
  ariaLabel,
}: {
  accounts: RetailPaymentAccounts | undefined;
  value: string;
  onValueChange: (value: string) => void;
  allowCredit?: boolean;
  customerName?: string | null;
  id?: string;
  testId?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const options = [
    ...(accounts?.ledgers ?? []).map((account) => ({
      value: `ledger:${account.id}`,
      name: account.name,
    })),
    ...(accounts?.banks ?? []).map((account) => ({
      value: `bank:${account.id}`,
      name: account.name,
    })),
    ...(allowCredit
      ? [{ value: "credit", name: customerName ? `Customer credit · ${customerName}` : "Customer credit" }]
      : []),
  ];
  return (
    <UnifiedAccountPicker
      id={id}
      testId={testId}
      options={options}
      value={value}
      onChange={onValueChange}
      placeholder="Select account"
      ariaLabel={ariaLabel ?? "Payment account"}
      className={className}
      allowClear
    />
  );
}
