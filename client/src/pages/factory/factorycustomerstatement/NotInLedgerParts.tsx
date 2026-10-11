import { Badge } from "@/components/ui/badge";

/**
 * The ledger / not-yet-in-the-ledger split of a factory customer's combined
 * balance (accounting audit wave 10). The combined figure stays the page's
 * main balance; this line shows what the ledger holds and what is not in it yet.
 */
export interface LedgerSplitFields {
  ledgerBalance?: number;
  ledgerBalanceSide?: string;
  /** Debit positive. */
  notInLedgerTotal?: number;
}

/** A statement row's flag: the amount is not in the ledger (listed for information). */
export interface NotInLedgerRowFields {
  notInLedger?: boolean;
  notInLedgerLabel?: string | null;
}

export function BalanceSplit({
  split,
  format,
  testId,
}: {
  split: LedgerSplitFields;
  format: (value: number) => string;
  testId: string;
}) {
  const { ledgerBalance, ledgerBalanceSide, notInLedgerTotal } = split;
  if (notInLedgerTotal === undefined || Math.abs(notInLedgerTotal) <= 0.005) return null;
  return (
    <span className="block text-xs text-muted-foreground font-normal mt-1" data-testid={testId}>
      <span>Ledger</span> {format(ledgerBalance ?? 0)} {ledgerBalanceSide} · <span>Not yet in the ledger</span>{" "}
      {format(Math.abs(notInLedgerTotal))} {notInLedgerTotal < 0 ? "Cr" : "Dr"}
    </span>
  );
}

/** Marks a statement row whose amount is not in the ledger. */
export function NotInLedgerBadge({ label, testId }: { label?: string | null; testId: string }) {
  return (
    <Badge variant="secondary" className="text-xs" title={label ?? undefined} data-testid={testId}>
      Not yet in the ledger
    </Badge>
  );
}
