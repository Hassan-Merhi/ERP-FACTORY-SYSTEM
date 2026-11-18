import type { ApiValue, VoucherViewEntry } from "./types";

/**
 * Factory voucher details use the same posted (book) balance as ERP Daybook.
 * Balances are current company-scoped ledger values, NOT balances at the
 * historical voucher date. Reading them must never create or amend postings.
 */
export interface FactoryVoucherCurrentBalances {
  sourceBalance: string | null;
  entryBalances: Record<number, string | null>;
}

export const FACTORY_BALANCE_VOUCHER_TYPES = new Set(["PAYMENT", "RECEIPT", "JOURNAL"]);

function validAccountId(value: ApiValue): number | null {
  const id = Number(value);
  return value !== null && value !== undefined && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function factoryVoucherBalanceUrl(entry: VoucherViewEntry): string | null {
  const ledgerId = validAccountId(entry.ledgerAccountId);
  if (ledgerId !== null) return `/api/accounts/ledger/${ledgerId}/balance?balanceBasis=book`;
  const bankId = validAccountId(entry.bankAccountId);
  if (bankId !== null) return `/api/accounts/ledger/${bankId}/balance?balanceBasis=book`;
  const customerId = validAccountId(entry.customerId);
  if (customerId !== null) return `/api/customers/${customerId}/balance`;
  const employeeId = validAccountId(entry.employeeId);
  if (employeeId !== null) return `/api/employees/${employeeId}/balance`;
  const supplierId = validAccountId(entry.supplierId);
  if (supplierId !== null) return `/api/suppliers/${supplierId}/balance`;
  const factorySupplierId = validAccountId(entry.factorySupplierId);
  if (factorySupplierId !== null) return `/api/factory/suppliers/${factorySupplierId}/balance`;
  return null;
}

export function factoryVoucherBalanceEntries(txType: string, entries: VoucherViewEntry[]) {
  const sourceEntry =
    txType === "PAYMENT"
      ? entries.find((entry) => Number(entry.creditAmount || 0) > 0)
      : txType === "RECEIPT"
        ? entries.find((entry) => Number(entry.debitAmount || 0) > 0)
        : undefined;
  const displayEntries =
    txType === "PAYMENT"
      ? entries.filter((entry) => Number(entry.debitAmount || 0) > 0)
      : txType === "RECEIPT"
        ? entries.filter((entry) => Number(entry.creditAmount || 0) > 0)
        : entries;
  return { sourceEntry, displayEntries };
}

async function fetchCurrentBalance(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const value = body && typeof body === "object" && "balance" in body ? body.balance : null;
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
    return Number.isFinite(Number(value)) ? String(value) : null;
  } catch (error) {
    // The details dialog may close or change companies while requests are in flight.
    if (signal?.aborted) throw error;
    return null; // unavailable is not a real zero balance
  }
}

export async function fetchFactoryVoucherCurrentBalances(
  txType: string,
  entries: VoucherViewEntry[],
  signal?: AbortSignal
): Promise<FactoryVoucherCurrentBalances> {
  const { sourceEntry, displayEntries } = factoryVoucherBalanceEntries(txType, entries);
  const sourceUrl = sourceEntry ? factoryVoucherBalanceUrl(sourceEntry) : null;
  const entryUrls = displayEntries.map((entry) => factoryVoucherBalanceUrl(entry));
  const urls = Array.from(new Set([sourceUrl, ...entryUrls].filter((url): url is string => url !== null)));
  const balancesByUrl = new Map(
    await Promise.all(urls.map(async (url) => [url, await fetchCurrentBalance(url, signal)] as const))
  );
  const entryBalances: Record<number, string | null> = {};
  displayEntries.forEach((entry, index) => {
    const url = entryUrls[index];
    entryBalances[entry.id] = url ? (balancesByUrl.get(url) ?? null) : null;
  });
  return { sourceBalance: sourceUrl ? (balancesByUrl.get(sourceUrl) ?? null) : null, entryBalances };
}
