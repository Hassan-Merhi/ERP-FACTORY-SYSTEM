import { useState } from "react";
import { ChevronDown, ChevronRight, Mail, AlertTriangle } from "lucide-react";
import { RunStatusBadge, fmtBytes, fmtTime, ChannelLine } from "./ExportCommon";

interface BackupRun {
  id: number;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  zipSizeBytes?: number;
  companiesCount?: number;
  companyFilesCount?: number;
  skippedCompanies?: string;
  skippedReason?: string;
  emailAttempted?: boolean;
  emailSuccess?: boolean;
  emailError?: string;
  emailAttempts?: number;
  whatsappAttempted?: boolean;
  whatsappSuccess?: boolean;
  whatsappError?: string;
  whatsappAttempts?: number;
}

function runTypeLabel(t: string): string {
  switch (t) {
    case "scheduled":
      return "Scheduled";
    case "manual_email":
      return "Manual — Email";
    case "manual_whatsapp":
      return "Manual — WhatsApp";
    case "manual_download":
      return "Manual — Download";
    default:
      return t;
  }
}
function runTypeBadgeClass(t: string): string {
  switch (t) {
    case "scheduled":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    case "manual_email":
      return "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300";
    case "manual_whatsapp":
      return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
    case "manual_download":
      return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function RunRow({ run }: { run: BackupRun }) {
  const [open, setOpen] = useState(false);
  const isRunning = run.status === "running";
  const isStuck = isRunning && run.startedAt ? Date.now() - new Date(run.startedAt).getTime() > 5 * 60 * 1000 : false;

  return (
    <div className="border rounded-md" data-testid={`run-row-${run.id}`}>
      <button className="w-full flex items-center gap-3 p-3 text-left hover-elevate" onClick={() => setOpen((v) => !v)}>
        <span
          className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium shrink-0 ${runTypeBadgeClass(run.runType)}`}
        >
          {runTypeLabel(run.runType)}
        </span>
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground ml-auto shrink-0">{fmtTime(run.startedAt)}</span>
        {(run.zipSizeBytes || run.companyFilesCount != null) && (
          <span className="text-xs text-muted-foreground hidden sm:block shrink-0">
            {run.companyFilesCount != null ? `${run.companyFilesCount} co.` : ""}
            {run.zipSizeBytes ? ` · ${fmtBytes(run.zipSizeBytes)}` : ""}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t px-3 pb-3 pt-2 space-y-2">
          {(run.zipSizeBytes || run.companyFilesCount != null || run.finishedAt) && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {run.zipSizeBytes ? <span>ZIP: {fmtBytes(run.zipSizeBytes)}</span> : null}
              {run.companyFilesCount != null ? (
                <span>
                  {run.companyFilesCount} compan{run.companyFilesCount === 1 ? "y" : "ies"}
                  {run.skippedCompanies ? ` (${run.skippedCompanies.split(",").filter(Boolean).length} skipped)` : ""}
                </span>
              ) : null}
              {run.finishedAt && !isRunning ? <span>Finished: {fmtTime(run.finishedAt)}</span> : null}
            </div>
          )}
          <div className="space-y-1.5">
            <ChannelLine
              icon={<Mail className="h-3 w-3" />}
              label="Email"
              attempted={run.emailAttempted}
              success={run.emailSuccess}
              error={run.emailError}
              attempts={run.emailAttempts}
            />
            <ChannelLine
              icon={<MessageSquare className="h-3 w-3" />}
              label="WhatsApp"
              attempted={run.whatsappAttempted}
              success={run.whatsappSuccess}
              error={run.whatsappError}
              attempts={run.whatsappAttempts}
            />
          </div>
          {run.skippedReason && <p className="text-xs text-muted-foreground">{run.skippedReason}</p>}
          {isStuck && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Stalled for over 5 minutes. Dismiss if needed.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { MessageSquare } from "lucide-react";
