import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const ROOT = "/api/factory/pressing-machines/report";

interface WorkerTotal {
  userId: string;
  name: string;
  totalBales: number;
  totalKg: string;
}
interface WorkerTotalsResponse {
  workers: WorkerTotal[];
}
const formatCount = (value: number) => value.toLocaleString();
const formatKg = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });

/** Workers see colleague totals, never another worker's individual bale history. */
export default function PressingWorkerTotals({ active, companyId, userId }: {
  active: boolean; companyId: number; userId: string;
}) {
  const totals = useQuery<WorkerTotalsResponse>({
    queryKey: [ROOT, "worker-totals", companyId, userId],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ROOT + "/worker-totals", {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load pressing worker totals");
      return response.json() as Promise<WorkerTotalsResponse>;
    },
    staleTime: 15000,
    // Only refresh the small aggregate, not the page or scanner camera.
    refetchInterval: active ? 30000 : false,
    refetchOnWindowFocus: false,
  });
  const workers = totals.data?.workers ?? [];
  const totalBales = workers.reduce((sum, worker) => sum + Number(worker.totalBales || 0), 0);
  const totalKg = workers.reduce((sum, worker) => sum + Number(worker.totalKg || 0), 0);

  return (
    <section className="min-w-0 space-y-3" data-testid="pressing-worker-totals">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Scanned Bales by Worker</h3>
          <p className="text-xs text-muted-foreground">All-time confirmed scans</p>
        </div>
        <Button type="button" size="sm" variant="outline"
          data-testid="button-refresh-pressing-totals"
          disabled={totals.isFetching}
          onClick={() => void totals.refetch()}>
          <RefreshCw className="mr-1 h-4 w-4" />Refresh
        </Button>
      </div>
      {totals.isLoading && <p className="text-sm text-muted-foreground">Loading worker totals…</p>}
      {totals.isError && (
        <p role="alert" className="text-sm text-destructive">
          {totals.error instanceof Error ? totals.error.message : "Could not load worker totals"}
        </p>
      )}
      {!totals.isLoading && !totals.isError && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="p-3 font-medium">Worker</th>
                <th scope="col" className="p-3 text-right font-medium">Total Bales</th>
                <th scope="col" className="p-3 text-right font-medium">Total KG</th>
              </tr>
            </thead>
            <tbody>
              {workers.map(worker => (
                <tr key={worker.userId} className="border-t">
                  <td className="p-3 font-medium">
                    {worker.name?.trim() || "Display name not set"}
                    {worker.userId === userId && <span className="ml-2 text-xs text-muted-foreground">(You)</span>}
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatCount(Number(worker.totalBales || 0))}</td>
                  <td className="p-3 text-right tabular-nums">{formatKg(Number(worker.totalKg || 0))}</td>
                </tr>
              ))}
              {!workers.length && (
                <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No pressing workers yet.</td></tr>
              )}
            </tbody>
            <tfoot className="border-t bg-muted/50 font-semibold">
              <tr>
                <td className="p-3">Total</td>
                <td className="p-3 text-right tabular-nums">{formatCount(totalBales)}</td>
                <td className="p-3 text-right tabular-nums">{formatKg(totalKg)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
