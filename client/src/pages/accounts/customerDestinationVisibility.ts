/** Customer-owned ledger records can be typed as regular "ledger" accounts. */
export function shouldShowFactoryCustomerDestination({
  appMode,
  accountType,
  statementCustomerId,
  destinations,
}: {
  appMode: string;
  accountType: string;
  statementCustomerId: number | null;
  destinations: ReadonlyArray<string | null | undefined>;
}): boolean {
  if (appMode !== "factory") return false;
  if (accountType === "customer") return true;
  if (statementCustomerId !== null && Number.isSafeInteger(statementCustomerId) && statementCustomerId > 0) {
    return true;
  }
  // Response metadata may be temporarily unavailable while React Query updates.
  // Only the customer-ledger statement endpoint enriches individual rows with
  // destinations; this lets already-loaded customer rows keep their UI visible.
  return destinations.some((destination) => Boolean(destination?.trim()));
}
