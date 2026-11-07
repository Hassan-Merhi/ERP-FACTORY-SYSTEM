/**
 * Build an account statement deep link on the CURRENT company's Accounts route.
 * This works for ERP, Factory, Properties, and any other company types sharing
 * the Accounts view, without switching the source tab's account selection.
 */
export function buildAccountStatementTabUrl(
  currentHref: string,
  account: { accountId: number; type: string },
  period: { fromDate?: string | null; toDate?: string | null },
): string {
  const url = new URL(currentHref);
  url.searchParams.set("accountId", String(account.accountId));
  url.searchParams.set("accountType", account.type);

  if (period.fromDate) url.searchParams.set("startDate", period.fromDate);
  else url.searchParams.delete("startDate");

  if (period.toDate) url.searchParams.set("endDate", period.toDate);
  else url.searchParams.delete("endDate");

  return `${url.pathname}${url.search}${url.hash}`;
}
