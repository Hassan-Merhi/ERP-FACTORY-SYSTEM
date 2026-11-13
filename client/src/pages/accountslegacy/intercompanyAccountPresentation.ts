import type { Account } from "../accounts/accountTypes";

/**
 * Intercompany technical posting legs are still in the GL, voucher history and
 * consolidated financial reporting. They are not independently payable/receivable
 * accounts that an operator should use in Accounts Overview.
 *
 * Never filter financial API data or zero balances: this is presentation only.
 */
export function showInIntercompanyAccountsOverview(account: Account, appMode: string): boolean {
  if (appMode === "factory" || account.type !== "ledger") return true;
  const code = account.code.toUpperCase();
  const name = account.name.toLowerCase();
  return !(
    /^IC-(?:SALES|COGS|PURCH|CHARGE|GIT|AP)-/.test(code) ||
    name.startsWith("intercompany goods in transit - ") ||
    name.startsWith("intercompany cost of goods sold - ") ||
    name.startsWith("intercompany sales - ") ||
    name.startsWith("confirmed container charges payable - ") ||
    name.startsWith("original purchases for ")
  );
}

export function presentIntercompanyAccount(account: Account, appMode: string): Account {
  if (appMode === "factory" || account.type !== "ledger") return account;
  if (/^IC-AR-/i.test(account.code) || /^intercompany receivable - /i.test(account.name)) {
    return {
      ...account,
      name: account.name.replace(/^intercompany receivable - /i, "Intercompany - "),
    };
  }
  return account;
}
