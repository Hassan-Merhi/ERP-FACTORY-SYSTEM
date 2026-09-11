import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar, Download, Mail, MessageSquare, ChevronDown, ChevronRight, RefreshCw, Building2 } from "lucide-react";
import { Recipient, ExportSettings, Company, BackupStatus, BackupRun } from "./ExportCenterTypes";
import { BackupStatusCard } from "./BackupStatusCard";

interface DailyExportTabProps {
  backupStatus?: BackupStatus;
  backupFetching: boolean;
  refetchBackup: () => void;
  companies: Company[];
  fromDate: string;
  setFromDate: (d: string) => void;
  toDate: string;
  setToDate: (d: string) => void;
  startExport: (mode: "download" | "email") => void;
  recipients: Recipient[];
  settings?: ExportSettings;
  waReady: boolean;
  sendingWa: boolean;
  sendViaWhatsApp: () => void;
  showCompanies: boolean;
  setShowCompanies: (v: boolean | ((v: boolean) => boolean)) => void;
  showHistory: boolean;
  setShowHistory: (v: boolean | ((v: boolean) => boolean)) => void;
  historyFilter: string;
  setHistoryFilter: (f: string) => void;
  filteredRuns: BackupRun[];
}

import { Badge } from "@/components/ui/badge";
import { RunRow } from "./BackupRunRow";

export function DailyExportTab({
  backupStatus,
  backupFetching,
  refetchBackup,
  companies,
  fromDate,
  setFromDate,
  toDate,
  setToDate,
  startExport,
  recipients,
  settings,
  waReady,
  sendingWa,
  sendViaWhatsApp,
  showCompanies,
  setShowCompanies,
  showHistory,
  setShowHistory,
  historyFilter,
  setHistoryFilter,
  filteredRuns,
}: DailyExportTabProps) {
  return (
    <div className="space-y-5 mt-4">
      {backupStatus && (
        <BackupStatusCard status={backupStatus} onRefresh={refetchBackup} isRefreshing={backupFetching} />
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Download className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Create an export</CardTitle>
              <CardDescription className="mt-1">
                Download the full company backup or send it to your configured recipients.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{companies.length} companies included</span>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => setShowCompanies((v) => !v)}
              data-testid="button-toggle-companies"
            >
              {showCompanies ? "Hide details" : "View details"}
            </button>
          </div>

          {showCompanies && (
            <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/20 p-3">
              {companies.length > 0 ? (
                companies.map((c) => (
                  <Badge key={c.id} variant="outline" className="bg-background">
                    {c.name}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">No companies available for export.</span>
              )}
            </div>
          )}

          <div className="rounded-lg border bg-background p-3 sm:p-4">
            <div className="mb-3">
              <p className="text-sm font-medium">Date range</p>
              <p className="text-xs text-muted-foreground">Leave both fields blank to include all history.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">From date</Label>
                <div className="relative">
                  <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="pl-9"
                    data-testid="input-daily-from"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">To date</Label>
                <div className="relative">
                  <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="pl-9"
                    data-testid="input-daily-to"
                  />
                </div>
              </div>
            </div>
            {(fromDate || toDate) && (
              <button
                type="button"
                className="mt-3 text-xs font-medium text-primary hover:underline"
                onClick={() => {
                  setFromDate("");
                  setToDate("");
                }}
              >
                Clear dates and use full history
              </button>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Choose how to deliver it</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                className="h-11 justify-start"
                disabled={companies.length === 0}
                onClick={() => startExport("download")}
                data-testid="button-export-now"
              >
                <Download className="mr-2 h-4 w-4" />
                Download ZIP
              </Button>
              <Button
                variant="outline"
                className="h-11 justify-start"
                onClick={() => startExport("email")}
                disabled={recipients.length === 0 || !settings?.gmailUser}
                data-testid="menu-export-email"
              >
                <Mail className="mr-2 h-4 w-4" />
                Send by email
              </Button>
              <Button
                variant="outline"
                className="h-11 justify-start"
                onClick={sendViaWhatsApp}
                disabled={!waReady || sendingWa}
                data-testid="menu-export-whatsapp"
              >
                <MessageSquare className="mr-2 h-4 w-4 text-green-600" />
                {sendingWa ? "Sending…" : "Send to WhatsApp"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {fromDate || toDate ? `Selected range: ${fromDate || "—"} to ${toDate || "—"}` : "Full history selected"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 p-4 text-left hover-elevate"
          onClick={() => setShowHistory((v) => !v)}
          data-testid="button-toggle-history"
        >
          <span className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            <span>
              <span className="block text-sm font-medium">Export history</span>
              <span className="block text-xs text-muted-foreground">
                {filteredRuns.length} of {(backupStatus?.recentRuns ?? []).length} recent runs
              </span>
            </span>
          </span>
          {showHistory ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {showHistory && (
          <div className="border-t p-4 space-y-3">
            {/* Filter pills */}
            {(backupStatus?.recentRuns ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {["all", "success", "failed", "running"].map((f) => (
                  <button
                    key={f}
                    onClick={() => setHistoryFilter(f)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${historyFilter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover-elevate"}`}
                    data-testid={`filter-history-${f}`}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            )}

            {filteredRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {(backupStatus?.recentRuns ?? []).length === 0
                  ? "No backup runs recorded yet. Trigger a manual send or wait for the scheduled run."
                  : "No runs match this filter."}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredRuns.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
