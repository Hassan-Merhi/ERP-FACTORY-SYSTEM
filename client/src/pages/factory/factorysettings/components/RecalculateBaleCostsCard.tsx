import type { ClientErrorLike } from "@/lib/clientError";
/**
 * RecalculateBaleCostsCard — extracted sub-component.
 *
 * Extracted from FactorySettings.tsx during the Phase 4 god-file split.
 */
import {useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {factoryApiRequest} from "@/lib/factoryApi";
import {Card, CardContent, CardHeader, CardTitle, CardDescription} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Loader2, Wrench} from "lucide-react";
import {useToast} from "@/hooks/use-toast";

export function RecalculateBaleCostsCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<{ balesUpdated: number } | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/raw-stock/recalculate-bale-costs");
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Done", description: data.message });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          Recalculate Old Bale Costs
        </CardTitle>
        <CardDescription>
          Updates the cost/kg and total cost on all existing bales to match their mix batch's current blended rate. Run
          this once to fix bales that were pressed before post-offload charges were added to their container.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result && <p className="text-sm text-muted-foreground">Last run: updated {result.balesUpdated} bale(s).</p>}
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          data-testid="button-recalculate-bale-costs"
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wrench className="h-4 w-4 mr-2" />}
          Recalculate Bale Costs
        </Button>
      </CardContent>
    </Card>
  );
}
