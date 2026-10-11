import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Target, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";

interface Allocation {
  allocationId: number;
  runId: number;
  productionDate: string;
  positionId: number;
  positionName: string;
  targetBales: number;
  actualBales: number;
  extraBales: number;
  rate: number;
  bonusPool: number;
  memberCount: number;
  workerId: number;
  workerName: string;
  amount: number;
  decisionStatus: "PENDING" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface BonusDetails {
  totals: {
    approved: number;
    pending: number;
    rejected: number;
    totalSuggested: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
  allocations: Allocation[];
}

export interface ProductionBonusDecisionResult {
  details: BonusDetails;
  otherBonus: number;
  totalBonus: number;
  netSalary: number;
  affected: number;
}

function money(value: number) {
  return Number(value || 0).toFixed(2);
}

function decisionBadge(status: Allocation["decisionStatus"]) {
  if (status === "APPROVED") {
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">Approved</Badge>;
  }
  if (status === "REJECTED") return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

export function ProductionBonusDecisionPanel({
  payrollId,
  payrollStatus,
  onChanged,
}: {
  payrollId: number;
  payrollStatus: string;
  onChanged?: (result: ProductionBonusDecisionResult) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["/api/factory/payroll", payrollId, "production-bonuses"];

  const { data, isLoading, isError, error } = useQuery<BonusDetails>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(`/api/factory/payroll/${payrollId}/production-bonuses`, { credentials: "include" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || "Failed to load production bonuses");
      return body as BonusDetails;
    },
    staleTime: 0,
  });

  const decisionMutation = useMutation({
    mutationFn: async ({
      decision,
      items,
      all,
    }: {
      decision: "APPROVED" | "REJECTED";
      items?: { runId: number; workerId: number }[];
      all?: boolean;
    }) => {
      const response = await factoryApiRequest(
        "POST",
        `/api/factory/payroll/${payrollId}/production-bonuses/decision`,
        {
          decision,
          items: items ?? [],
          all: all === true,
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || "Failed to update production bonus");
      return body as ProductionBonusDecisionResult;
    },
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["/api/factory/payroll"] });
      onChanged?.(result);
      toast({ title: variables.decision === "APPROVED" ? "Production bonus approved" : "Production bonus rejected" });
    },
    onError: (mutationError: Error) =>
      toast({ title: "Production bonus update failed", description: mutationError.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading production bonus suggestions…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
        {(error as Error)?.message || "Could not load production bonuses"}
      </div>
    );
  }

  const details = data ?? {
    totals: {
      approved: 0,
      pending: 0,
      rejected: 0,
      totalSuggested: 0,
      pendingCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
    },
    allocations: [],
  };
  const canDecide = payrollStatus === "DRAFT";

  return (
    <div className="space-y-3 rounded-xl border bg-muted/20 p-3" data-testid="production-bonus-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-semibold">Production Bonus</div>
            <div className="text-xs text-muted-foreground">
              Calculated from saved position targets and attributed Stock Entry bales.
            </div>
          </div>
        </div>
        {details.totals.pendingCount > 0 && canDecide && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={decisionMutation.isPending}
              onClick={() => decisionMutation.mutate({ decision: "REJECTED", all: true })}
              data-testid="button-reject-all-production-bonuses"
            >
              <X className="mr-1 h-3.5 w-3.5" /> Reject All
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={decisionMutation.isPending}
              onClick={() => decisionMutation.mutate({ decision: "APPROVED", all: true })}
              data-testid="button-approve-all-production-bonuses"
            >
              <Check className="mr-1 h-3.5 w-3.5" /> Approve All
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase text-muted-foreground">Suggested</div>
          <div className="font-mono text-sm font-bold">${money(details.totals.totalSuggested)}</div>
        </div>
        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase text-muted-foreground">Approved</div>
          <div className="font-mono text-sm font-bold text-green-600">${money(details.totals.approved)}</div>
        </div>
        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase text-muted-foreground">Pending</div>
          <div className="font-mono text-sm font-bold">${money(details.totals.pending)}</div>
        </div>
        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase text-muted-foreground">Rejected</div>
          <div className="font-mono text-sm font-bold text-muted-foreground">${money(details.totals.rejected)}</div>
        </div>
      </div>

      {details.allocations.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No production bonus was generated for this worker in this payroll period.
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {details.allocations.map((allocation) => (
            <div key={allocation.allocationId} className="rounded-lg border bg-background p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    {allocation.positionName} · {allocation.productionDate}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Target {allocation.targetBales} · Actual {allocation.actualBales} · Extra {allocation.extraBales} ·
                    ${money(allocation.rate)}/extra bale
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Team pool ${money(allocation.bonusPool)} ÷ {allocation.memberCount} worker
                    {allocation.memberCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-base font-bold">${money(allocation.amount)}</div>
                  {decisionBadge(allocation.decisionStatus)}
                </div>
              </div>

              {canDecide && (
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={decisionMutation.isPending || allocation.decisionStatus === "REJECTED"}
                    onClick={() =>
                      decisionMutation.mutate({
                        decision: "REJECTED",
                        items: [{ runId: allocation.runId, workerId: allocation.workerId }],
                      })
                    }
                    data-testid={`button-reject-production-bonus-${allocation.allocationId}`}
                  >
                    Reject
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={decisionMutation.isPending || allocation.decisionStatus === "APPROVED"}
                    onClick={() =>
                      decisionMutation.mutate({
                        decision: "APPROVED",
                        items: [{ runId: allocation.runId, workerId: allocation.workerId }],
                      })
                    }
                    data-testid={`button-approve-production-bonus-${allocation.allocationId}`}
                  >
                    Approve
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!canDecide && details.allocations.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Production bonus decisions are locked once payroll leaves Draft status.
        </div>
      )}
    </div>
  );
}
