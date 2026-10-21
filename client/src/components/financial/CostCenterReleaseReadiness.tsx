/** Read-only release-preflight status for privileged ERP and Factory administrators. */
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, RefreshCw, AlertTriangle } from "lucide-react";
import { readCostCenterApi } from "@/api/costCentersApi";

type Readiness = {
  structuralReady: boolean;
  tables: Array<{ name: string; exists: boolean; rlsEnabled: boolean; forceRls: boolean }>;
  missingTriggers: string[];
  missingFunctions: string[];
  warning: string;
};
export function CostCenterReleaseReadiness({ baseUrl }: { baseUrl: string }) {
  const { selectedCompany } = useCompany();
  const role = selectedCompany?.role || "";
  const canInspect = ["Admin", "Owner", "Developer"].includes(role);
  const { data, error, isLoading, refetch } = useQuery<Readiness>({
    queryKey: [baseUrl, selectedCompany?.id, "release-readiness"],
    queryFn: () => readCostCenterApi<Readiness>(baseUrl + "/release-readiness"),
    enabled: canInspect && !!selectedCompany?.id,
    staleTime: 60000,
    retry: false,
  });
  if (!canInspect) return null;
  const missingTables = data?.tables.filter((t) => !t.exists || !t.rlsEnabled || !t.forceRls) || [];
  return (
    <Card data-testid="cost-center-release-readiness">
      <CardContent className="p-3 sm:p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Cost Center Database Readiness
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {data && (
              <Badge variant={data.structuralReady ? "secondary" : "destructive"}>
                {data.structuralReady ? "Structure present" : "Migration prerequisites missing"}
              </Badge>
            )}
            <Button size="sm" variant="ghost" onClick={() => void refetch()}>
              <RefreshCw className="h-3 w-3 mr-1" /> Recheck
            </Button>
          </div>
        </div>
        {isLoading && <p className="text-xs text-muted-foreground">Inspecting required database structure…</p>}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            Readiness could not be determined; do not assume the migrations are applied.
          </p>
        )}
        {data && (
          <>
            <p className="text-xs text-muted-foreground">{data.warning}</p>
            {!data.structuralReady && (
              <div className="space-y-1 text-xs">
                {missingTables.length > 0 && (
                  <p>
                    <AlertTriangle className="inline w-3 h-3 mr-1" />
                    Tables/RLS: {missingTables.map((t) => t.name).join(", ")}
                  </p>
                )}
                {data.missingTriggers.length > 0 && <p>Triggers: {data.missingTriggers.join(", ")}</p>}
                {data.missingFunctions.length > 0 && <p>Functions: {data.missingFunctions.join(", ")}</p>}
              </div>
            )}
            {data.structuralReady && (
              <p className="text-xs text-muted-foreground">
                Structure alone is not a test result. Claude must still validate migrations, permissions, historical FX,
                source reconciliation and accounting invariants before enabling production workflows.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
