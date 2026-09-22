import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import type { ContainerOptimizationPlan } from "@shared/containerOptimizer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Props {
  planId: number;
  capacityBales: number;
  includeGarbageWipers: boolean;
  onPlanChanged: () => void;
}

function formatQty(value: number): string {
  return Math.round(Number(value || 0)).toLocaleString();
}

const KIND_LABEL: Record<string, string> = {
  CUSTOMER: "Customer order",
  SINGLE_PRODUCT: "Single product",
  MIXED: "Mixed",
};

/**
 * Phase 7 panel: asks the optimizer what the containers should look like, and
 * optionally rewrites the draft plan with that layout.
 */
export function ContainerPlannerOptimizer({ planId, capacityBales, includeGarbageWipers, onPlanChanged }: Props) {
  const { toast } = useToast();
  const [suggestion, setSuggestion] = useState<ContainerOptimizationPlan | null>(null);

  const previewMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/factory/v5/container-plans/optimize", {
        capacityBales,
        includeGarbageWipers,
      });
      return (await response.json()) as { suggestion: ContainerOptimizationPlan };
    },
    onSuccess: (data) => setSuggestion(data.suggestion),
    onError: (error: Error) =>
      toast({ title: "Could not build a suggestion", description: error.message, variant: "destructive" }),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/factory/v5/container-plans/${planId}/optimize/apply`, {});
      return (await response.json()) as { suggestion: ContainerOptimizationPlan };
    },
    onSuccess: (data) => {
      setSuggestion(data.suggestion);
      onPlanChanged();
      toast({ title: `Plan rebuilt into ${data.suggestion.containerCount} optimized containers` });
    },
    onError: (error: Error) =>
      toast({ title: "Could not apply the suggestion", description: error.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="container-plan-optimizer">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold">Smart optimization</p>
            <p className="text-xs text-muted-foreground">
              Whole containers per customer order first, then single-product containers, then one mixed tail.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
            data-testid="button-optimize-preview"
          >
            {previewMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Suggest layout
          </Button>
          <Button
            size="sm"
            disabled={applyMutation.isPending || !suggestion || suggestion.containerCount === 0}
            onClick={() => applyMutation.mutate()}
            data-testid="button-optimize-apply"
          >
            Apply to this plan
          </Button>
        </div>
      </div>

      {suggestion && (
        <div className="mt-3" data-testid="container-optimizer-suggestion">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{formatQty(suggestion.containerCount)} containers</Badge>
            <Badge variant="secondary">{Math.round(suggestion.averageFillPercent)}% average fill</Badge>
            <Badge variant="secondary">{formatQty(suggestion.customerContainers)} ship-ready</Badge>
            <Badge variant="secondary">{formatQty(suggestion.unusedCapacity)} bales of unused capacity</Badge>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
            {suggestion.containers.map((container) => (
              <Card key={container.index} data-testid={`card-suggested-container-${container.index}`}>
                <CardContent className="p-3">
                  <div className="truncate text-xs font-semibold">
                    {container.customerName || KIND_LABEL[container.kind] || container.kind}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {formatQty(container.totalBales)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      / {formatQty(suggestion.capacity)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {container.lines.map((line) => (
                      <p key={line.articleCode} className="truncate text-[11px] text-muted-foreground">
                        {line.productName} · {formatQty(line.qty)}
                      </p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {suggestion.unservedDemand.length > 0 && (
            <div className="mt-3 text-xs text-amber-600" data-testid="text-unserved-demand">
              Not enough stock for:{" "}
              {suggestion.unservedDemand
                .map((row) => `${row.customerName} ${row.productName} ${formatQty(row.shortfallQty)}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
