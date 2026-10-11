/**
 * Group presentation currency (accounting audit phase 24, MC-5; owner
 * decision: the group is presented in USD).
 *
 * Every company's ledger is kept in USD (phase 23 G15: the functional currency
 * is the company's base_currency, USD for every company today), so the group
 * net position adds USD figures and an intercompany transfer posts the same
 * USD amount in both companies. A company whose base currency is not USD would
 * need its figures translated to USD first (phase 26 consolidation, MC-6): it
 * is listed here so the group report shows it instead of adding its figures as
 * if they were USD.
 */
export const GROUP_PRESENTATION_CURRENCY = "USD" as const;

export interface CompanyCurrencyRow {
  id: number;
  name?: string | null;
  baseCurrency?: string | null;
}

/** Companies whose ledger currency is not the group presentation currency. */
export function companiesNeedingTranslation(
  companies: readonly CompanyCurrencyRow[]
): Array<{ companyId: number; companyName: string | null; baseCurrency: string }> {
  return companies
    .map((company) => ({
      companyId: company.id,
      companyName: company.name ?? null,
      baseCurrency: String(company.baseCurrency || GROUP_PRESENTATION_CURRENCY)
        .trim()
        .toUpperCase(),
    }))
    .filter((row) => row.baseCurrency !== GROUP_PRESENTATION_CURRENCY);
}
