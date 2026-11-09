import type { FactoryContainer } from "@shared/schema";
import { FACTORY_CONTAINER_STATUS_LABELS } from "@shared/factoryStatusPresentation";

export interface ContainerWithSupplier extends FactoryContainer {
  supplierName?: string | null;
}

export const OTW_NOTES_KEY = "factory-otw-notes";

export const STATUS_ACTIVE = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);

export const CCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  AUD: "A$",
  CAD: "C$",
  CHF: "CHF",
  JPY: "¥",
  CNY: "¥",
  AED: "AED",
  SAR: "SAR",
  LBP: "LL",
};

export const OTW_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  ARRIVED: "Arrived",
};

export const CONTAINER_STATUS_LABELS: Readonly<Record<string, string>> = FACTORY_CONTAINER_STATUS_LABELS;

export function getContainerStatusLabel(status: string): string {
  return CONTAINER_STATUS_LABELS[status] ?? status;
}

export function otwNum(v: string | null | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

export function otwCcySymbol(code: string | null | undefined): string {
  if (!code) return "$";
  return CCY_SYMBOLS[code] || code;
}

export function otwFmtCcy(symbol: string, amount: number): string {
  return `${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function otwAddToCurrency(map: Record<string, number>, ccy: string, amount: number) {
  if (amount > 0 && ccy) map[ccy] = (map[ccy] || 0) + amount;
}

export function otwContainerByCurrency(c: ContainerWithSupplier): Record<string, number> {
  const amounts: Record<string, number> = {};
  const containerCcy = c.currencyCode || "USD";
  const goodsValue =
    otwNum(c.finalPayableAmount) > 0 ? otwNum(c.finalPayableAmount) : otwNum(c.ratePerKg) * otwNum(c.totalKg);
  otwAddToCurrency(amounts, containerCcy, goodsValue);
  otwAddToCurrency(amounts, c.freightCurrencyCode || containerCcy, otwNum(c.freight));
  otwAddToCurrency(amounts, c.commissionCurrencyCode || "USD", otwNum(c.commissionAmount));
  otwAddToCurrency(amounts, containerCcy, otwNum(c.otherCharges));
  otwAddToCurrency(
    amounts,
    containerCcy,
    otwNum(
      (c as unknown as ContainerWithSupplier & { additionalChargesSum: string | null | undefined }).additionalChargesSum
    )
  );
  otwAddToCurrency(
    amounts,
    containerCcy,
    otwNum(
      (c as unknown as ContainerWithSupplier & { preRegisteredChargesSum: string | null | undefined })
        .preRegisteredChargesSum
    )
  );
  return amounts;
}

export function otwMergeCurrencyMaps(target: Record<string, number>, source: Record<string, number>) {
  for (const [ccy, amt] of Object.entries(source)) {
    target[ccy] = (target[ccy] || 0) + amt;
  }
}
