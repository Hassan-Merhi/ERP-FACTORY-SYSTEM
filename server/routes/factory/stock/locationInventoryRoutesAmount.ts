// Extracted from ./locationInventoryRoutes.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

/** A stored amount (or its fallback when empty) as an exact decimal. */
export const amount = (value: unknown, fallback = "0") => toMoney((value || fallback) as string);

/** a + b computed exactly; running totals stay numbers in these responses. */
export const plus = (a: number, b: Decimal | number) => toMoney(a).plus(b).toNumber();

/** Rounded half up to 2 decimals, as a number for the spreadsheet cell. */
export const cents = (value: Decimal) => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();
