// Extracted from ./reports.ts to keep that module under the source-size cap.
import { lineAmount, toMoney } from "../../lib/money";

/** qty × per-bale amount, exact. */
export const times = (qty: number, perBale: number): number => lineAmount(qty, perBale).toNumber();

/** a − b, exact (per-bale price differences). */
export const diff = (a: number, b: number): number => toMoney(a).minus(toMoney(b)).toNumber();
