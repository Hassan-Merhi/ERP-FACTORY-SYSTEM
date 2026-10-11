import { toMoney } from "../../lib/money";
export interface HassanPriceMetrics {
  price: number;
  profit: number;
  percentage: number;
}

function toFiniteNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : toMoney(value).toNumber();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateHassanPriceMetrics(
  actualSellingPrice: string | number | null | undefined,
  priceListSellingPrice: string | number | null | undefined,
  quantity: string | number | null | undefined
): HassanPriceMetrics | null {
  const price = toFiniteNumber(priceListSellingPrice);
  if (price <= 0) return null;

  const actualPrice = toFiniteNumber(actualSellingPrice);
  const qty = toFiniteNumber(quantity);
  const profit = (actualPrice - price) * qty;
  const referenceTotal = price * qty;
  const percentage = referenceTotal === 0 ? 0 : (profit / referenceTotal) * 100;

  return { price, profit, percentage };
}
