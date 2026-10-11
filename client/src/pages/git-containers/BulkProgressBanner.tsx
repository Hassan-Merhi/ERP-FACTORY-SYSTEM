import { Card, CardContent } from "@/components/ui/card";
import { Loader2, CheckCircle2, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface BulkProgress {
  running: boolean;
  total: number;
  processed: number;
  current: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface BulkProgressBannerProps {
  showProgressBanner: boolean;
  bulkProgress: BulkProgress | null;
  setShowProgressBanner: (show: boolean) => void;
}

export function BulkProgressBanner({
  showProgressBanner,
  bulkProgress,
  setShowProgressBanner,
}: BulkProgressBannerProps) {
  if (!showProgressBanner || !bulkProgress) return null;

  return (
    <div className="relative animate-in slide-in-from-top duration-300" data-testid="banner-bulk-progress">
      <Card className="border-sky-200 bg-sky-50/50 dark:bg-sky-900/10 dark:border-sky-800/50">
        <CardContent className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {bulkProgress.running ? (
                <Loader2 className="h-4 w-4 text-sky-600 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              )}
              <span className="text-sm font-semibold">
                {bulkProgress.running ? "Active Auto-tracking Run" : "Auto-tracking Run Complete"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-muted-foreground uppercase">
                {bulkProgress.processed} / {bulkProgress.total} PROCESSED
              </span>
              <button
                onClick={() => setShowProgressBanner(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <Progress value={Math.min(100, (bulkProgress.processed / bulkProgress.total) * 100)} className="h-1.5 mb-2" />
          {bulkProgress.running && bulkProgress.current && (
            <p className="text-[11px] text-muted-foreground italic truncate">
              Tracking: <span className="font-mono text-sky-700 dark:text-sky-400">{bulkProgress.current}</span>
            </p>
          )}
          {!bulkProgress.running && (
            <p className="text-[11px] text-green-700 dark:text-green-400 font-medium">
              Run finished at {new Date(bulkProgress.completedAt!).toLocaleTimeString()}. Table will refresh in 6 s.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
