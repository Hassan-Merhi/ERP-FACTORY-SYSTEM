/**
 * Validation for ERP company exchange rates (USD -> local transaction units).
 *
 * Database exchange_rates.rate has decimal(20,6): at most 14 integer digits
 * and 6 fractional digits. Do not accept trailing junk such as "25abc", scientific
 * notation, zero, or values that would be rounded to zero on persistence.
 *
 * This does not fetch market rates, write data, or select a company.
 */
import { z } from "zod";

export const companyRateValueSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/, "Enter a positive rate with at most 6 decimal places.")
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
    message: "Rate must be greater than zero.",
  });

export const companyRateDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid calendar date.");

/**
 * Company ZMW display pricing is supported only with a USD accounting base.
 * Future bases need dedicated posting/accounting work, not an implicit rate.
 */
export function isSupportedZmwCompanyPair(
  baseCurrency: string | null | undefined,
  displayCurrency: string | null | undefined
): boolean {
  return String(displayCurrency || "").toUpperCase() !== "ZMW" || String(baseCurrency || "").toUpperCase() === "USD";
}
