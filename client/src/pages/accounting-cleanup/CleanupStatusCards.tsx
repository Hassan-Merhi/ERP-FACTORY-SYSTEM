import { useState } from "react";
import { Activity, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequestPrivileged } from "@/lib/queryClient";

import { describeRefusal, type Refusal } from "./cleanupRefusals";

type IntegrityStatus = "pass" | "warn" | "fail";

interface IntegrityCheck {
  key: string;
  status: IntegrityStatus;
  count: number;
  amount: string | null;
  explanation: string;
}

export interface IntegrityReport {
  status: IntegrityStatus;
  generatedAt: string;
  checks: IntegrityCheck[];
  trialBalance: { balanced: boolean; unexplainedDifference: string };
}

const STATUS_TEXT: Record<IntegrityStatus, string> = { fail: "Fail", warn: "Warning", pass: "Pass" };
const STATUS_VARIANT: Record<IntegrityStatus, "destructive" | "secondary" | "outline"> = {
  fail: "destructive",
  warn: "secondary",
  pass: "outline",
};

export function integrityCounts(report: IntegrityReport): Record<IntegrityStatus, number> {
  const counts: Record<IntegrityStatus, number> = { fail: 0, warn: 0, pass: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  return counts;
}

function CheckList({ checks, testId }: { checks: IntegrityCheck[]; testId: string }) {
  const order: IntegrityStatus[] = ["fail", "warn", "pass"];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <ul className="space-y-2" data-testid={testId}>
      {sorted.map((check) => (
        <li key={check.key} className="rounded-md border p-2 text-sm" data-testid={`integrity-check-${check.key}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[check.status]}>{STATUS_TEXT[check.status]}</Badge>
            <code className="text-xs">{check.key}</code>
            <span className="font-mono tabular-nums" data-business-value>
              {check.amount ? `${check.count} · ${check.amount}` : String(check.count)}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{check.explanation}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Read-only: the integrity diagnostic of the current company (GET
 * /api/accounting/integrity), findings by severity, and its audit-trail checks
 * (triggers, unknown actors, hash chain).
 */
export function IntegrityStatusCard({ role }: { role: string }) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [running, setRunning] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const canRun = ["Admin", "Owner", "Developer"].includes(role);

  const run = async () => {
    setRunning(true);
    setRefusal(null);
    try {
      setReport((await (await apiRequestPrivileged("GET", "/api/accounting/integrity")).json()) as IntegrityReport);
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setRunning(false);
    }
  };

  const counts = report ? integrityCounts(report) : null;
  const auditChecks = report?.checks.filter((check) => check.key.startsWith("audit_")) ?? [];
  const otherChecks =
    report?.checks.filter((check) => !check.key.startsWith("audit_") && check.status !== "pass") ?? [];

  return (
    <Card data-testid="card-cleanup-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Activity className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Where the books stand
        </CardTitle>
        <CardDescription>
          Read only. The integrity diagnostic runs the audit's ledger checks for the current company, including the
          audit trail checks; run it before and after each step.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          variant="outline"
          onClick={run}
          disabled={!canRun || running}
          className="w-full sm:w-auto"
          data-testid="button-run-integrity"
        >
          {running && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {report ? "Run again" : "Run the integrity diagnostic"}
        </Button>
        {refusal && (
          <p className="text-sm text-destructive" role="alert" data-testid="error-integrity">
            {refusal.serverMessage || refusal.message}
          </p>
        )}
        {report && counts && (
          <div className="space-y-3" data-testid="integrity-report">
            <div className="flex flex-wrap gap-2">
              <Badge variant="destructive" data-testid="count-integrity-fail">{`Fail: ${counts.fail}`}</Badge>
              <Badge variant="secondary" data-testid="count-integrity-warn">{`Warning: ${counts.warn}`}</Badge>
              <Badge variant="outline" data-testid="count-integrity-pass">{`Pass: ${counts.pass}`}</Badge>
              <Badge
                variant={report.trialBalance.balanced ? "outline" : "destructive"}
                data-testid="badge-trial-balance"
              >
                {report.trialBalance.balanced
                  ? "Trial balance balanced"
                  : `Trial balance difference: ${report.trialBalance.unexplainedDifference}`}
              </Badge>
            </div>
            {otherChecks.length > 0 && <CheckList checks={otherChecks} testId="integrity-findings" />}
            <div className="space-y-1">
              <p className="text-sm font-medium">Audit trail checks</p>
              {auditChecks.length > 0 ? (
                <CheckList checks={auditChecks} testId="integrity-audit-trail" />
              ) : (
                <p className="text-sm text-muted-foreground">No audit trail check in this report.</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
