import { Account } from "./analyticsTypes";

export const parseBalance = (balance: number | string): number => {
  if (typeof balance === "string") {
    return parseFloat(balance) || 0;
  }
  return balance || 0;
};

export const signedBalance = (acc: Account) =>
  acc.balanceSide === "Cr" ? parseBalance(acc.balance) : -parseBalance(acc.balance);

export const calculateChildrenTotal = (parentAccountId: number, accountMap: Map<number, Account[]>) => {
  const children = accountMap.get(parentAccountId) || [];
  return children.reduce((sum, acc) => sum + signedBalance(acc), 0);
};

export const calculateTotal = (accountList: Account[]) => {
  const accountIds = new Set(accountList.map((acc) => acc.accountId));
  const parentAccountIds = new Set(accountList.filter((acc) => acc.parentId).map((acc) => acc.parentId!));

  let total = 0;
  accountList.forEach((acc) => {
    const hasChildrenInList = parentAccountIds.has(acc.accountId);
    const isChildOfParentInList = acc.parentId && accountIds.has(acc.parentId);

    if (hasChildrenInList) {
      const children = accountList.filter((child) => child.parentId === acc.accountId);
      total += children.reduce((sum, child) => sum + signedBalance(child), 0);
    } else if (!isChildOfParentInList) {
      total += signedBalance(acc);
    }
  });
  return total;
};

export const groupAccountsByParent = (accountList: Account[]) => {
  const accountIdsInList = new Set(accountList.map((acc) => acc.accountId));
  const parentAccounts: Account[] = [];
  const childAccounts: Account[] = [];

  accountList.forEach((acc) => {
    if (!acc.parentId || !accountIdsInList.has(acc.parentId)) {
      parentAccounts.push(acc);
    } else {
      childAccounts.push(acc);
    }
  });

  const accountMap = new Map<number, Account[]>();
  childAccounts.forEach((child) => {
    const parentId = child.parentId!;
    if (!accountMap.has(parentId)) {
      accountMap.set(parentId, []);
    }
    accountMap.get(parentId)!.push(child);
  });

  return { parentAccounts, accountMap };
};

export const formatSmartCurrency = (value: number): string => {
  const absValue = Math.abs(value);
  const isWholeNumber = absValue % 1 === 0;
  if (isWholeNumber) {
    return "$" + absValue.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return "$" + absValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const goToStatement = (
  accountId: number,
  appMode: string,
  customerId?: number,
  accountType?: string,
  navigate?: (url: string) => void,
) => {
  if (customerId && appMode === "factory") {
    // Customer detail — keep new-tab (no factory-context problem for customer pages)
    window.open(`/factory/customers/${customerId}`, "_blank");
    return;
  }
  if (appMode === "factory") {
    // Same-tab SPA navigation keeps the factory session context intact.
    // window.open(_blank) opens a fresh tab where factory context isn't
    // re-established, causing the access guard to redirect to home.
    const url = `/factory/accounts?accountId=${accountId}&accountType=ledger`;
    if (navigate) {
      navigate(url);
    } else {
      window.location.href = url;
    }
    return;
  }
  window.open(`/ledger-monthly/${accountId}`, "_blank");
};
