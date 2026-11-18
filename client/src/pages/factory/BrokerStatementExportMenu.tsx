import { RowsExportMenu, type RowsExportSheet } from "@/components/export/RowsExportMenu";
import {
  ccySymbol,
  fmt,
  useFactoryBrokerVisualStatementState,
  type BrokerContainer,
  type BrokerPayment,
} from "./useFactoryBrokerVisualStatementState";

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  payment: "Payment",
  fx_in: "FX In",
  fx_out: "FX Out",
  voucher: "Voucher",
};

/** Per-container grand total by currency. */
export function containerGrandTotal(c: BrokerContainer): Partial<Record<string, number>> {
  const out: Record<string, number> = {};
  const add = (cc: string, amt: number) => {
    out[cc] = (out[cc] || 0) + amt;
  };
  if (c.goodsAmount) add(c.goodsCurrency, c.goodsAmount);
  if (c.freightAmount) add(c.freightCurrency, c.freightAmount);
  if (c.commissionAmount) add(c.commissionCurrency, c.commissionAmount);
  return out;
}

/** Excel export of the containers table and the payments table, as the statement shows them. */
export function BrokerStatementExportMenu({
  allCurrencies,
  containerTotals,
  formatDisplayDate,
  from,
  paymentTotals,
  statement,
  to,
}: Pick<
  ReturnType<typeof useFactoryBrokerVisualStatementState>,
  "allCurrencies" | "containerTotals" | "formatDisplayDate" | "from" | "paymentTotals" | "statement" | "to"
>) {
  if (!statement) return null;
  return (
    <RowsExportMenu
      title="Broker Statement"
      period={{ from, to }}
      filters={statement.broker?.name ? [{ label: "Broker", value: statement.broker.name }] : undefined}
      sheetName="Containers"
      rows={statement.containers ?? []}
      columns={[
        { header: "Supplier", value: (c) => c.supplierName },
        { header: "Container", value: (c) => c.containerNumber },
        { header: "Date", value: (c) => (c.arrivalDate ? formatDisplayDate(c.arrivalDate) : null) },
        { header: "Unit Price", value: (c) => (c.ratePerKg > 0 ? c.ratePerKg : null), type: "number" },
        { header: "Weight (kg)", value: (c) => c.weight || null, type: "number" },
        ...allCurrencies.map((cc) => ({
          header: `Goods ${cc}`,
          value: (c: BrokerContainer) => (c.goodsCurrency === cc && c.goodsAmount > 0 ? c.goodsAmount : null),
          type: "number" as const,
        })),
        ...allCurrencies.map((cc) => ({
          header: `Freight ${cc}`,
          value: (c: BrokerContainer) => (c.freightCurrency === cc && c.freightAmount > 0 ? c.freightAmount : null),
          type: "number" as const,
        })),
        ...allCurrencies.map((cc) => ({
          header: `Comm. ${cc}`,
          value: (c: BrokerContainer) =>
            c.commissionCurrency === cc && c.commissionAmount > 0 ? c.commissionAmount : null,
          type: "number" as const,
        })),
        ...allCurrencies.map((cc) => ({
          header: `Total ${cc}`,
          value: (c: BrokerContainer) => containerGrandTotal(c)[cc] || null,
          type: "number" as const,
        })),
      ]}
      footer={[
        `TOTAL — ${statement.containers?.length ?? 0} containers`,
        null,
        null,
        null,
        null,
        ...allCurrencies.map((cc) => containerTotals[cc]?.goods || null),
        ...allCurrencies.map((cc) => containerTotals[cc]?.freight || null),
        ...allCurrencies.map((cc) => containerTotals[cc]?.commission || null),
        ...allCurrencies.map((cc) => {
          const t = containerTotals[cc];
          const grand = t ? t.goods + t.freight + t.commission : 0;
          return grand > 0 ? grand : null;
        }),
      ]}
      extraSheets={[
        {
          name: "Payments",
          rows: statement.payments ?? [],
          columns: [
            { header: "Date", value: (p) => (p.date ? formatDisplayDate(p.date) : null) },
            { header: "Type", value: (p) => PAYMENT_TYPE_LABELS[p.type] || p.type },
            { header: "Supplier / Details", value: (p) => p.supplierName },
            { header: "Currency", value: (p) => p.fromCurrency },
            { header: "Amount", value: (p) => p.fromAmount || null, type: "number" },
            {
              header: "FX Rate",
              value: (p) => (p.fxRate ? Number(p.fxRate.toFixed(4)) : null),
              type: "number",
            },
            { header: "$ USD", value: (p) => p.usdAmount || null, type: "number" },
            { header: "Notes", value: (p) => p.notes },
          ],
          footer: [
            "TOTAL PAID",
            null,
            null,
            // Per-currency totals as the page shows them (text, several currencies).
            Object.entries(paymentTotals)
              .filter(([, v]) => v !== 0)
              .map(([cc, v]) => `${ccySymbol(cc)}${fmt(v)}`)
              .join(" / "),
            null,
            null,
            (statement.payments ?? []).reduce((sum: number, p) => sum + p.usdAmount, 0),
            null,
          ],
        } satisfies RowsExportSheet<BrokerPayment>,
      ]}
      resource="factory.accounting"
      data-testid="button-export-broker-statement"
    />
  );
}
