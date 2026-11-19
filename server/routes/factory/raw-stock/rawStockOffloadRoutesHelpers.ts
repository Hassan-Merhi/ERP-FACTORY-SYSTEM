// Extracted from ./rawStockOffloadRoutes.ts: shared helpers.
import { parseMoneyInput } from "../../../lib/money";

/** A request amount as the number parseFloat read it (NaN when it does not parse). */
export function requestNumber(value: unknown): number {
  return parseMoneyInput(value)?.toNumber() ?? NaN;
}
