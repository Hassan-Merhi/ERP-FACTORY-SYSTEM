import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Database, Loader2, PackageCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";

const CARRY_FORWARD_URL = "/api/sp/golden-coast/cutover/existing-position-carry-forward";

interface CarryForwardPlan {
  stockInHandUsd: string;
  stockOtwUsd: string;
  totalPositionUsd: string;
  inventoryRowCount: number;
  fifoMovementCount: number;
  locations: Array<{ locationId: number; locationName: string; quantity: string; valueUsd: string; rowCount: number }>;
  otwContainers: Array<{ containerId: number; containerNumber: string; valueUsd: string }>;
  journalEntries: Array<{ debitAmount: string; creditAmount: string; narration: string }>;
}

interface CarryForwardState {
  cutoverDate: string;
  voucherNumber: string;
  posted: boolean;
  canApply: boolean;
  blockers: string[];
  plan: CarryForwardPlan | null;
}

function formatUsd(value: string | number): string {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function createRequestKey(): string {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
  return uuid ? `gc-carry-forward:${uuid}` : `gc-carry-forward:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function ExistingPositionCarryForwardPanel({ companyKey }: { companyKey: number | string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = [CARRY_FORWARD_URL, companyKey];
  const { data, isLoading, isError } = useQuery<CarryForwardState>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(CARRY_FORWARD_URL, { credentials: "include" });
      if (!response.ok) throw new Error("Carry-forward status is unavailable");
      return response.json();
    },
    enabled: companyKey !== "no-company",
    retry: false,
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", CARRY_FORWARD_URL, {
        confirmation: "RUN SP MIGRATION",
        reason: "Carry forward the existing joint Stock in Hand and Stock OTW position",
        idempotencyKey: createRequestKey(),
      });
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.state);
      queryClient.invalidateQueries({ queryKey: ["/api/sp/golden-coast/phase6/pos-sale/readiness"] });
      toast({
        title: releaseDebtEnglish("Golden Coast existing position carried forward"),
        description: releaseDebtEnglish(
          "FIFO opening lots are ready. POS sales can now use the Golden Coast accounting flow."
        ),
      });
    },
    onError: (error: Error) =>
      toast({ title: releaseDebtEnglish("Carry-forward blocked"), description: error.message, variant: "destructive" }),
  });

  if (isLoading || isError || !data) return null;

  const plan = data.plan;
  return (
    <Card data-testid="gc-existing-position-carry-forward">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" />
              {releaseDebtEnglish("Existing position carry-forward")}
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              {releaseDebtEnglish(
                "One-time bridge for the Stock in Hand and Stock OTW already included in Net Position. Locations and partner capital stay unchanged."
              )}
            </CardDescription>
          </div>
          {data.posted ? (
            <Badge variant="outline" className="border-green-600/40 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" /> {releaseDebtEnglish("Complete")}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-600/40 text-amber-600">
              <AlertCircle className="mr-1 h-3 w-3" /> {releaseDebtEnglish("Action needed")}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Stock in Hand")}</p>
                <p className="mt-1 font-semibold">{formatUsd(plan.stockInHandUsd)}</p>
              </div>
              <div className="rounded-md bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Stock OTW")}</p>
                <p className="mt-1 font-semibold">{formatUsd(plan.stockOtwUsd)}</p>
              </div>
              <div className="rounded-md bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Total carried position")}</p>
                <p className="mt-1 font-semibold">{formatUsd(plan.totalPositionUsd)}</p>
              </div>
            </div>

            <div className="grid gap-3 text-sm md:grid-cols-2">
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <PackageCheck className="h-4 w-4" /> {releaseDebtEnglish("Location inventory")}
                </div>
                <p className="text-xs text-muted-foreground">
                  {plan.inventoryRowCount} {releaseDebtEnglish("rows")} · {plan.fifoMovementCount}{" "}
                  {releaseDebtEnglish("FIFO lots")}
                </p>
                <div className="mt-2 space-y-1">
                  {plan.locations.map((location) => (
                    <div key={location.locationId} className="flex justify-between gap-2 text-xs">
                      <span>{location.locationName}</span>
                      <span className="font-medium">{formatUsd(location.valueUsd)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <ShieldCheck className="h-4 w-4" /> {releaseDebtEnglish("Active OTW containers")}
                </div>
                <div className="space-y-1">
                  {plan.otwContainers.length > 0 ? (
                    plan.otwContainers.map((container) => (
                      <div key={container.containerId} className="flex justify-between gap-2 text-xs">
                        <span>{container.containerNumber}</span>
                        <span className="font-medium">{formatUsd(container.valueUsd)}</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">{releaseDebtEnglish("None")}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-md border p-3">
              <p className="mb-2 text-sm font-medium">{releaseDebtEnglish("Accounting preview")}</p>
              <div className="space-y-1">
                {plan.journalEntries.map((entry, index) => (
                  <div key={`${entry.narration}-${index}`} className="flex flex-wrap justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{entry.narration}</span>
                    <span className="font-mono">
                      {Number(entry.debitAmount) > 0
                        ? `Dr ${formatUsd(entry.debitAmount)}`
                        : `Cr ${formatUsd(entry.creditAmount)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {data.blockers.length > 0 && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/20 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              {data.blockers.map((blocker) => (
                <p key={blocker}>{blocker}</p>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => applyMutation.mutate()}
            disabled={!data.canApply || applyMutation.isPending}
            data-testid="button-gc-existing-position-carry-forward"
          >
            {applyMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="mr-2 h-4 w-4" />
            )}
            {data.posted ? releaseDebtEnglish("Already applied") : releaseDebtEnglish("Apply carry-forward")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => queryClient.invalidateQueries({ queryKey })}
            disabled={applyMutation.isPending}
            data-testid="button-gc-existing-position-refresh"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {releaseDebtEnglish("Refresh preview")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {releaseDebtEnglish("Cutover date")}: <span className="font-mono">{data.cutoverDate}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
