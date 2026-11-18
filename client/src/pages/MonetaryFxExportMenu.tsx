import { RowsExportMenu, type RowsExportSheet } from "@/components/export/RowsExportMenu";
import type { Bucket, RateMatrix, Realized, RealizedList, Valuation } from "./monetaryFxAccountingTypes";

/** Excel export of the rate matrix, the cash/bank valuation and the realized FX list, as the page shows them. */
export function MonetaryFxExportMenu({
  asOfDate,
  rates,
  valuation,
  realized,
}: {
  asOfDate: string;
  rates: RateMatrix | undefined;
  valuation: Valuation | undefined;
  realized: RealizedList | undefined;
}) {
  return (
    <RowsExportMenu
      title="Multi-Currency Accounting"
      period={{ to: asOfDate }}
      sheetName="Exchange rates"
      rows={rates?.rates ?? []}
      columns={[
        { header: "Currency", value: (row) => row.currency },
        { header: "USD per unit", value: (row) => row.rate?.rateBasePerUnit, type: "number" },
        { header: "Units per USD", value: (row) => row.rate?.rateUnitPerBase, type: "number" },
        { header: "Effective date", value: (row) => row.rate?.effectiveDate },
        { header: "Stored direction", value: (row) => row.rate?.source ?? "No recorded rate" },
      ]}
      extraSheets={[
        ...(valuation
          ? [
              {
                name: "Cash and bank valuation",
                rows: valuation.buckets,
                columns: [
                  { header: "Currency", value: (b) => b.currency },
                  { header: "Native balance", value: (b) => b.nativeBalance, type: "number" },
                  { header: "Historical USD", value: (b) => b.historicalUsdBasis, type: "number" },
                  { header: "Dated USD / unit", value: (b) => b.rate?.rateBasePerUnit, type: "number" },
                  { header: "Translated USD", value: (b) => b.translatedUsd, type: "number" },
                  { header: "Unrealized difference", value: (b) => b.unrealizedDifferenceUsd, type: "number" },
                  {
                    header: "Evidence",
                    value: (b) =>
                      [b.rate ? `${b.rate.source} · effective ${b.rate.effectiveDate}` : "", ...b.issues]
                        .filter(Boolean)
                        .join("; "),
                  },
                ],
              } satisfies RowsExportSheet<Bucket>,
            ]
          : []),
        ...(realized
          ? [
              {
                name: "Realized FX",
                rows: realized.items,
                columns: [
                  { header: "Match", value: (item) => `#${item.matchId}` },
                  { header: "Party", value: (item) => `${item.domain} #${item.partyId}` },
                  { header: "Invoice", value: (item) => item.chargeVoucher },
                  { header: "Settlement", value: (item) => item.settlementVoucher },
                  { header: "Native matched", value: (item) => item.nativeMatchedAmount, type: "number" },
                  { header: "Currency", value: (item) => item.nativeCurrency },
                  { header: "Invoice basis USD", value: (item) => item.chargeHistoricalUsd, type: "number" },
                  { header: "Settlement basis USD", value: (item) => item.settlementHistoricalUsd, type: "number" },
                  { header: "Realized FX USD", value: (item) => item.realizedGainUsd, type: "number" },
                  { header: "Posting", value: (item) => item.status },
                  {
                    header: "Journal",
                    value: (item) => (item.recognitionVoucherId ? `Journal #${item.recognitionVoucherId}` : null),
                  },
                  { header: "Issue", value: (item) => item.issue },
                ],
              } satisfies RowsExportSheet<Realized>,
            ]
          : []),
      ]}
      resource="erp.accounts"
      data-testid="button-export-monetary-fx"
    />
  );
}
