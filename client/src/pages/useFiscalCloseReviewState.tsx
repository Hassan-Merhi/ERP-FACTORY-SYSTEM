// Extracted from ./FiscalCloseReview.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FiscalCloseReviewCardSectionContent, useFiscalCloseReviewState } from "./FiscalCloseReviewCardSectionContent";
export { useFiscalCloseReviewState } from "./FiscalCloseReviewCardSectionContent";

export function FiscalCloseReviewCardSection({
  accounts,
  canQuery,
  data,
  end,
  readiness,
  retainedId,
  setConfirmText,
  setEnd,
  setRetainedId,
  setStart,
  start,
}: Pick<
  ReturnType<typeof useFiscalCloseReviewState>,
  | "accounts"
  | "canQuery"
  | "data"
  | "end"
  | "readiness"
  | "retainedId"
  | "setConfirmText"
  | "setEnd"
  | "setRetainedId"
  | "setStart"
  | "start"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Period and retained earnings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <FiscalCloseReviewCardSectionContent
          accounts={accounts}
          end={end}
          retainedId={retainedId}
          setConfirmText={setConfirmText}
          setEnd={setEnd}
          setRetainedId={setRetainedId}
          setStart={setStart}
          start={start}
        />
        {data?.history.latestClosedEnd && (
          <p className="text-sm text-muted-foreground">
            Latest closed period ends {data.history.latestClosedEnd}. Next period must begin{" "}
            {data.history.expectedNextStart}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Only an existing active Equity account from this company is accepted. No account is created automatically. For
          date periods that are still open, review only; a close cannot include today.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!canQuery || readiness.isFetching} onClick={() => readiness.refetch()}>
            Refresh financial evidence
          </Button>
          <span className="text-xs text-muted-foreground">
            Every refresh recalculates the evidence fingerprint from the current posted ledger.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
