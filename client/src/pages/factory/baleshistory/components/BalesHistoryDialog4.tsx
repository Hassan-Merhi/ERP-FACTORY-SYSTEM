import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useBalesHistoryModel } from "../useBalesHistoryModel";
import { ExportButton } from "@/components/export/ReportExportMenu";

type Model = ReturnType<typeof useBalesHistoryModel>;

export function BalesHistoryDialog4({ model }: { model: Model }) {
  const {
    showExportDialog,
    setShowExportDialog,
    exportFrom,
    setExportFrom,
    exportTo,
    setExportTo,
    exportLoading,
    handleExport,
  } = model;
  return (
    <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Export Stock Register</DialogTitle>
          <DialogDescription>
            Exports all bales (all statuses) to Excel with reference numbers, article codes, product names, weights,
            dates and more. Leave dates blank to export everything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <p className="text-sm text-muted-foreground mb-1">From Date</p>
              <Input
                type="date"
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
                data-testid="input-export-from"
              />
            </div>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground mb-1">To Date</p>
              <Input
                type="date"
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
                data-testid="input-export-to"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowExportDialog(false)} disabled={exportLoading}>
            Cancel
          </Button>
          <ExportButton
            variant="default"
            onClick={handleExport}
            disabled={exportLoading}
            busy={exportLoading}
            data-testid="button-confirm-export"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
