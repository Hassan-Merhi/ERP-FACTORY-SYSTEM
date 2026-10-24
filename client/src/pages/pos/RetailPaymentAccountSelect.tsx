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
  selection: string, amount: number, accounts: RetailPaymentAccounts
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

export function RetailPaymentAccountOptions({
  accounts, allowCredit = false, customerName,
}: {
  accounts: RetailPaymentAccounts | undefined;
  allowCredit?: boolean;
  customerName?: string | null;
}) {
  return (
    <>
      <option value="">Select account</option>
      {accounts?.ledgers.length ? (
        <optgroup label="Cash / bank ledgers">
          {accounts.ledgers.map((entry) => (
            <option key={`ledger:${entry.id}`} value={`ledger:${entry.id}`}>
              {entry.code} · {entry.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {accounts?.banks.length ? (
        <optgroup label="Bank accounts">
          {accounts.banks.map((entry) => (
            <option key={`bank:${entry.id}`} value={`bank:${entry.id}`}>
              {entry.code} · {entry.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {allowCredit ? (
        <option value="credit">{customerName ? `Customer credit · ${customerName}` : "Customer credit (selected customer's ledger)"}</option>
      ) : null}
    </>
  );
}
