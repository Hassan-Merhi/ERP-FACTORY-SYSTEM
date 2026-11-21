// Extracted from ./FactoryWaste.tsx
import { ErrorState, LoadingState } from "@/components/ui/page-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { useFactoryWasteState } from "./useFactoryWasteState";

export function FactoryWasteCard({
  deleteMutation,
  formatDisplayDate,
  recordChanges,
  setPendingDeleteId,
  wasteQuery,
}: Pick<
  ReturnType<typeof useFactoryWasteState>,
  "deleteMutation" | "formatDisplayDate" | "recordChanges" | "setPendingDeleteId" | "wasteQuery"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Waste Entries</CardTitle>
      </CardHeader>
      <CardContent>
        {wasteQuery.isLoading ? (
          <LoadingState title="Loading waste entries..." data-testid="loading-spinner" />
        ) : wasteQuery.isError && !wasteQuery.data ? (
          <ErrorState onAction={() => void wasteQuery.refetch()} actionLabel="Try again" />
        ) : !Array.isArray(wasteQuery.data) || wasteQuery.data.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground" data-testid="text-no-data">
              No waste entries for selected range
            </p>
          </div>
        ) : (
          <div className="table-responsive">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>KG</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Mix Batch</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wasteQuery.data.map((entry, idx) => (
                  <TableRow key={entry.id ?? idx} data-testid={`row-waste-${entry.id}`}>
                    <TableCell className="font-mono text-sm">
                      {entry.date ? formatDisplayDate(entry.date) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{entry.wasteType || "—"}</TableCell>
                    <TableCell className="font-mono">{entry.kgWaste}</TableCell>
                    <TableCell>{entry.reason || "—"}</TableCell>
                    <TableCell className="font-mono">{entry.mixBatchId ?? "—"}</TableCell>
                    <TableCell className="font-mono">{entry.supplierId ?? "—"}</TableCell>
                    <TableCell className="font-mono">{entry.containerId ?? "—"}</TableCell>
                    <TableCell>
                      {recordChanges.allowed && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setPendingDeleteId(entry.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-waste-${entry.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
