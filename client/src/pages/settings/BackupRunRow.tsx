import { getErrorDetails } from "@shared/errorUtils";
import { Download, Mail, MessageSquare, AlertTriangle, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { BackupRun } from "./ExportCenterTypes";
import { fmtBytes, fmtTime, runTypeLabel, runTypeBadgeClass } from "./ExportCenterHelpers";

export function RunRow({ run }: { run: BackupRun }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const retryEmail = async () => {
    try {
      await apiRequest("POST", `/api/export/retry-email/${run.id}`);
      toast({ title: "Retry requested", description: "System will attempt to re-send the email shortly." });
      qc.invalidateQueries({ queryKey: ["/api/export/backup-status"] });
    } catch (e) {
      toast({ variant: "destructive", title: "Retry failed", description: getErrorDetails(e).message });
    }
  };

  const retryWhatsApp = async () => {
    try {
      await apiRequest("POST", `/api/export/retry-whatsapp/${run.id}`);
      toast({ title: "Retry requested", description: "System will attempt to re-send via WhatsApp shortly." });
      qc.invalidateQueries({ queryKey: ["/api/export/backup-status"] });
    } catch (e) {
      toast({ variant: "destructive", title: "Retry failed", description: getErrorDetails(e).message });
    }
  };

  const isFailed = run.status === "failed" || run.status === "partial_failed";
  const isRunning = run.status === "running";

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border bg-card/50 text-xs" data-testid={`run-row-${run.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge className={`px-1.5 py-0 text-[10px] uppercase font-bold border-0 ${runTypeBadgeClass(run.runType)}`}>
            {runTypeLabel(run.runType)}
          </Badge>
          <span className="font-medium text-muted-foreground">{fmtTime(run.startedAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          {run.zipSizeBytes && (
            <span className="text-muted-foreground flex items-center gap-1">
              <Download className="h-3 w-3" />
              {fmtBytes(run.zipSizeBytes)}
            </span>
          )}
          {run.status === "success" && (
            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-0">
              Success
            </Badge>
          )}
          {run.status === "partial_failed" && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-0">
              Partial Fail
            </Badge>
          )}
          {run.status === "failed" && (
            <Badge variant="destructive" className="border-0">
              Failed
            </Badge>
          )}
          {isRunning && (
            <Badge variant="secondary" className="animate-pulse">
              Running
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground">
        <div className="flex items-center gap-1">
          <ChevronRight className="h-3 w-3" /> {run.companiesCount || 0} companies ({run.companyFilesCount || 0} files)
        </div>

        {/* Email status */}
        {run.emailAttempted && (
          <div className="flex items-center gap-1.5">
            <Mail className={`h-3 w-3 ${run.emailSuccess ? "text-green-600" : "text-destructive"}`} />
            <span>Email: {run.emailSuccess ? "Sent" : "Failed"}</span>
            {!run.emailSuccess && !isRunning && (
              <button onClick={retryEmail} className="text-primary hover:underline font-medium ml-1">
                Retry
              </button>
            )}
          </div>
        )}

        {/* WhatsApp status */}
        {run.whatsappAttempted && (
          <div className="flex items-center gap-1.5">
            <MessageSquare className={`h-3 w-3 ${run.whatsappSuccess ? "text-green-600" : "text-destructive"}`} />
            <span>WhatsApp: {run.whatsappSuccess ? "Sent" : "Failed"}</span>
            {!run.whatsappSuccess && !isRunning && (
              <button onClick={retryWhatsApp} className="text-primary hover:underline font-medium ml-1">
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {isFailed && (run.emailError || run.whatsappError || run.skippedReason) && (
        <div className="mt-1 p-2 rounded-sm bg-destructive/10 text-destructive border border-destructive/20 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            {run.emailError && <p>Email: {run.emailError}</p>}
            {run.whatsappError && <p>WhatsApp: {run.whatsappError}</p>}
            {run.skippedReason && <p>Note: {run.skippedReason}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
