import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarRange, Loader2, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { factoryApiRequest } from "@/lib/factoryApi";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import type { WeeklyFlatBonusProposal, WeeklyFlatWorkerProposal } from "@shared/productionTargetBonusWeeklyCalculation";

const endpoint = "/api/factory/production-target-bonuses/weekly-preview";
type ReviewableWorker = WeeklyFlatWorkerProposal & { reviewToken: string | null };
type PreviewResponse = Omit<WeeklyFlatBonusProposal, "workers"> & {
  workers: ReviewableWorker[]; dayCount: number; note: string;
};
type Decision = "approved" | "rejected";
interface RecordedReview {
  id: number; workerId: number; status: Decision; amount: string;
  reviewedBy: string; reviewedAt: string; methodVersionId: number;
  snapshotHash: string; snapshot: { workerName: string; targetBales: string; creditedBales: number };
}
interface ReviewsResponse { weekStart: string; reviews: RecordedReview[]; }
const reviewsEndpoint = "/api/factory/production-target-bonuses/weekly-reviews";
async function fetchReviews(weekOf: string): Promise<ReviewsResponse> {
  const response = await factoryApiRequest("GET", reviewsEndpoint + "?" + new URLSearchParams({ weekOf }));
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.message || "Cannot load weekly bonus decisions");
  }
  return response.json() as Promise<ReviewsResponse>;
}
async function load(weekOf: string): Promise<PreviewResponse> {
  const response = await factoryApiRequest("GET", endpoint + "?" + new URLSearchParams({ weekOf }).toString());
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Could not calculate weekly flat bonus preview");
  }
  return response.json() as Promise<PreviewResponse>;
}
const formatReason = (issue: string) => issue.replaceAll("_", " ").toLowerCase();

/** Read-only Phase 13 eligibility preview; no approval or posting controls. */
export function ProductionBonusWeeklyPreviewPanel({ initialDate }: { initialDate: string }) {
  const [weekOf, setWeekOf] = useState(initialDate);
  const [decision, setDecision] = useState<{ workerId: number; status: Decision } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const { toast } = useToast();
  useEffect(() => setWeekOf(initialDate), [initialDate]);
  const valid = isBonusCategoryDate(weekOf);
  const { data, error, isLoading } = useQuery<PreviewResponse>({
    queryKey: [endpoint, weekOf],
    queryFn: () => load(weekOf),
    enabled: valid,
  });
  const { data: reviewed, error: reviewsError } = useQuery<ReviewsResponse>({
    queryKey: [reviewsEndpoint, weekOf],
    queryFn: () => fetchReviews(weekOf),
    enabled: valid,
  });
  const reviewsByWorker = new Map((reviewed?.reviews ?? []).map(row => [row.workerId, row]));
  const selectedWorker = data?.workers.find(row => row.workerId === decision?.workerId);
  const saveDecision = useMutation({
    mutationFn: async () => {
      if (!decision || !selectedWorker?.reviewToken || !data) throw new Error("Refresh the weekly proposal");
      const response = await factoryApiRequest("POST", reviewsEndpoint + "/decide", {
        weekStart: data.weekStart, workerId: decision.workerId,
        decision: decision.status, expectedAmount: selectedWorker.proposedBonusUsd,
        reviewToken: selectedWorker.reviewToken, confirm: true, note: reviewNote,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.message || "Cannot review weekly bonus");
      }
      return response.json() as Promise<{ replayed: boolean }>;
    },
    onSuccess: outcome => {
      toast({
        title: outcome.replayed ? "Weekly review already recorded" : "Weekly bonus reviewed",
        description: "Immutable decision recorded. No payment or accounting voucher was created.",
      });
      setDecision(null); setReviewNote("");
      void queryClient.invalidateQueries({ queryKey: [reviewsEndpoint] });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
    onError: (cause: Error) => toast({
      title: "Weekly review not saved", description: cause.message, variant: "destructive",
    }),
  });
  const totalEligible = data?.workers.filter(worker =>
    worker.eligible && !reviewsByWorker.has(worker.workerId)).length ?? 0;
  return (
    <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-weekly-preview">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <CalendarRange className="mr-2 inline h-4 w-4" /> Weekly flat bonus eligibility — preview only
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs text-muted-foreground">
          A worker earns the same fixed bonus for 1 or 30 extra bales above their total weekly target.
          Linked production is credited once per worker; category changes are combined, not paid separately.
          An absent day with no production is excluded from that worker's target.
          Only a completed Monday–Sunday week with frozen, reconciled production evidence can qualify.
          Confirming a review locks the proposed amount. A review is not a payment.
        </p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Select a date in the week
          <Input type="date" aria-label="Weekly flat bonus preview date" className="w-[170px]"
            value={weekOf} onChange={event => setWeekOf(event.target.value)} />
        </label>
        {!valid && <p role="alert" className="text-sm text-destructive">Choose a valid date.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {reviewsError && <p role="alert" className="text-sm text-destructive">{(reviewsError as Error).message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Checking finalized weekly evidence…
        </p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3 text-sm">
              <span className="font-medium">{data.weekStart} to {data.weekEnd}</span>
              <span>{data.dayCount} saved production days</span>
              <span>{data.totalCreditedBales} credited bales</span>
              <span>{totalEligible} eligible workers</span>
              <span className="font-semibold tabular-nums">USD {data.totalProposedBonusUsd} proposed</span>
              <Badge variant="secondary">Preview · not payable</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Selected method: {data.method === "weekly_flat" ? "Weekly flat bonus" : "Per extra bale (existing)"}
              {data.method === "weekly_flat" && " · USD " + data.flatBonusUsd + " per eligible worker per week"}
              . Settings version: {data.methodVersionId ?? "default"}.
            </p>
            {data.globalIssues.length > 0 && <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Weekly amounts are blocked: {data.globalIssues.map(formatReason).join(", ")}.
              Complete or reconcile the source evidence before attempting a future review.
            </p>}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Worker</th>
                    <th className="px-3 py-2 text-right">Weekly target</th>
                    <th className="px-3 py-2 text-right">Credited</th>
                    <th className="px-3 py-2 text-right">Extra</th>
                    <th className="px-3 py-2 text-right">Flat bonus USD</th>
                    <th className="px-3 py-2">Eligibility / review</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workers.map(worker => {
                    const recorded = reviewsByWorker.get(worker.workerId);
                    return <tr key={worker.workerId} className="border-t align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{worker.workerName}</p>
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Daily and category details</summary>
                        <div className="mt-1 space-y-1">
                          {worker.dayBreakdown.map(day => (
                            <p key={day.date}>{day.date}: {day.creditedBales} bales, target {day.targetBales ?? "none"}, {day.status}</p>
                          ))}
                          <p>Categories: {worker.categories.map(item =>
                            item.categoryLabel + " (" + item.creditedBales + ")").join(", ") || "None"}</p>
                        </div>
                      </details>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.targetBales}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.creditedBales}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{worker.extraBales}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{recorded?.amount ?? worker.proposedBonusUsd}</td>
                    <td className="px-3 py-2">
                      {recorded ? (
                        <div>
                          <Badge variant="secondary">{recorded.status === "approved"
                            ? "Approved · not paid" : "Rejected"}</Badge>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {recorded.reviewedBy} · {new Date(recorded.reviewedAt).toLocaleString()}
                          </p>
                        </div>
                      ) : worker.eligible ? <Badge>Exceeds target · proposal</Badge> :
                        worker.blocked ? <Badge variant="destructive">Blocked</Badge> :
                          <Badge variant="secondary">Target not exceeded</Badge>}
                      {!recorded && worker.eligible && worker.reviewToken && reviewed && !reviewsError &&
                        <div className="mt-2 flex flex-wrap gap-1">
                          <Button type="button" size="sm" variant="outline"
                            onClick={() => { setReviewNote(""); setDecision({ workerId: worker.workerId, status: "rejected" }); }}>
                            Reject
                          </Button>
                          <Button type="button" size="sm"
                            onClick={() => { setReviewNote(""); setDecision({ workerId: worker.workerId, status: "approved" }); }}>
                            Approve
                          </Button>
                        </div>}
                      {worker.reasons.length > 0 &&
                        <p className="mt-1 max-w-[260px] text-xs text-destructive">
                          {worker.reasons.map(formatReason).join(", ")}
                        </p>}
                    </td>
                  </tr>;
                  })}
                  {data.workers.length === 0 && <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                      No worker production found in the selected week.
                    </td>
                  </tr>}
                </tbody>
              </table>
            </div>
            {reviewed && reviewed.reviews.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {reviewed.reviews.length} immutable weekly review(s) recorded for this week.
                Approved means authorized but not paid.
              </p>
            )}
            <p className="text-xs text-muted-foreground">{data.note}</p>
            <AlertDialog open={decision !== null}
              onOpenChange={open => { if (!open && !saveDecision.isPending) setDecision(null); }}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Confirm weekly bonus {decision?.status === "approved" ? "approval" : "rejection"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {selectedWorker?.workerName ?? "Selected worker"} · week of {data.weekStart} ·
                    USD {selectedWorker?.proposedBonusUsd ?? "0.00"}.
                    This is an immutable review, not a cash payment. The fee, target,
                    credited bales, category breakdown and saved method version will be locked.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <label className="space-y-1 text-sm">
                  Review note (optional)
                  <Input aria-label="Weekly flat bonus review note" maxLength={500}
                    value={reviewNote} onChange={event => setReviewNote(event.target.value)} />
                </label>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={saveDecision.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={!selectedWorker?.reviewToken || saveDecision.isPending}
                    onClick={event => { event.preventDefault(); saveDecision.mutate(); }}>
                    {saveDecision.isPending ? "Saving decision…" : "Confirm decision"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </details>
  );
}
