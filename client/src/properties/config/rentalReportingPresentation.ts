import { getAppDate } from "@/lib/queryClient";
import { hasVerifiedUsdBasis } from "./rentalCurrencyBasis";
import type { PaymentsPeriod } from "@/pages/properties/property-rental/components/PropertiesPaymentsPremium";

/** Read-only presentation currency. Never silently add unconverted currencies. */
export function hasSingleUsdBasis(rows: readonly { currency?: string | null }[]): boolean {
  return hasVerifiedUsdBasis(rows);
}

/** A financial figure explicitly identifies the source of its calculation. */
export type RentalReportingBasis = "posted-cash" | "contract-paid" | "reconciled-account-balances" | "posted-ledger-expense";
export type RentalReportingFigure = Readonly<{
  amount: number | null;
  currency: "USD";
  basis: RentalReportingBasis;
  asOfDate: string | null;
}>;

export function rentalReportingFigure(
  amount: number | null,
  basis: RentalReportingBasis,
  asOfDate: string | null = null,
): RentalReportingFigure {
  return { amount, currency: "USD", basis, asOfDate };
}

function validDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Preserve the recorded calendar day; do not parse it as browser-local midnight. */
export function paymentDayKey(value: string): string | null {
  const day = value.slice(0, 10);
  return validDayKey(day) ? day : null;
}

export function rentalPeriodStart(period: PaymentsPeriod, businessToday: string = getAppDate()): string | null {
  if (period === "all") return null;
  if (!validDayKey(businessToday)) return null;
  if (period === "month") return businessToday.slice(0, 7) + "-01";
  if (period === "year") return businessToday.slice(0, 4) + "-01-01";
  const day = new Date(businessToday + "T00:00:00.000Z");
  day.setUTCDate(day.getUTCDate() - 29);
  return day.toISOString().slice(0, 10);
}

export function isRentalDayInPeriod(paymentDate: string, since: string | null): boolean {
  if (since === null) return true;
  const day = paymentDayKey(paymentDate);
  return day !== null && day >= since;
}

/** Inclusive company-calendar range. All dates are recorded calendar days, not instants. */
export type RentalPeriodBounds = Readonly<{ since: string; through: string }>;

/** "All" stays unbounded; invalid business dates fail closed for dated periods. */
export function rentalPeriodBounds(period: PaymentsPeriod, businessToday: string = getAppDate()): RentalPeriodBounds | null {
  if (period === "all" || !validDayKey(businessToday)) return null;
  return { since: rentalPeriodStart(period, businessToday)!, through: businessToday };
}

export function isRentalDayInRange(paymentDate: string, bounds: RentalPeriodBounds): boolean {
  const day = paymentDayKey(paymentDate);
  return day !== null && day >= bounds.since && day <= bounds.through;
}
