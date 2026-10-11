import { lazy, Suspense, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequestPrivileged } from "@/lib/queryClient";

import { describeRefusal, type Refusal } from "./cleanupRefusals";

const FiscalPeriodTab = lazy(() =>
  import("@/components/FiscalPeriodTab").then((module) => ({ default: module.FiscalPeriodTab }))
);

interface TrialBalanceResponse {
  balanced: boolean;
  unexplainedDifference: string;
  rows: Array<{ id: number | null; kind: string; closingDebit: string; closingCredit: string }>;
}

interface SystemAccountsResponse {
  statuses: Array<{ code: string; state: string }>;
}

interface NormalizationResponse {
  unknown: Array<{ id: number; code: string | null; name: string; accountType: string }>;
}

export interface FiscalPrecheck {
  balanced: boolean;
  difference: string;
  retainedEarnings: boolean;
  unknownTypeBalances: Array<{ id: number; name: string; accountType: string }>;
}

const nonZero = (value: string) => /[1-9]/.test(value ?? "");

/** The three conditions the close refuses without (phase 23 G12), from the read-only routes. */
export function fiscalPrecheck(
  trialBalance: TrialBalanceResponse,
  systemAccounts: SystemAccountsResponse,
  normalization: NormalizationResponse
): FiscalPrecheck {
  const withBalance = new Set(
    trialBalance.rows
      .filter(
        (row) => row.kind === "ledger" && row.id !== null && (nonZero(row.closingDebit) || nonZero(row.closingCredit))
      )
      .map((row) => row.id as number)
  );
  const retained = systemAccounts.statuses.find((status) => status.code === "RETAINED_EARNINGS");
  return {
    balanced: trialBalance.balanced,
    difference: trialBalance.unexplainedDifference,
    retainedEarnings: !!retained && ["ok", "created"].includes(retained.state),
    unknownTypeBalances: normalization.unknown.filter((account) => withBalance.has(account.id)),
  };
}

function CheckLine({ ok, label, testId }: { ok: boolean; label: string; testId: string }) {
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={testId} data-ok={ok ? "true" : "false"}>
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <span>{label}</span>
    </li>
  );
}

export function FiscalCloseCheck({ role }: { role: string }) {
  const { selectedCompany } = useCompany();
  const [check, setCheck] = useState<FiscalPrecheck | null>(null);
  const [running, setRunning] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const canRun = ["Admin", "Owner", "Developer"].includes(role);

  const run = async () => {
    setRunning(true);
    setRefusal(null);
    try {
      const [trialBalance, systemAccounts, normalization] = await Promise.all(
        [
          "/api/accounting/trial-balance",
          "/api/accounting/system-accounts",
          "/api/accounting/account-types/normalization",
        ].map(async (url) => (await apiRequestPrivileged("GET", url)).json())
      );
      setCheck(
        fiscalPrecheck(
          trialBalance as TrialBalanceResponse,
          systemAccounts as SystemAccountsResponse,
          normalization as NormalizationResponse
        )
      );
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setRunning(false);
    }
  };

  const ready = !!check && check.balanced && check.retainedEarnings && check.unknownTypeBalances.length === 0;

  return (
    <div className="space-y-3" data-testid="fiscal-close-check">
      <Button
        variant="outline"
        onClick={run}
        disabled={!canRun || running}
        className="w-full sm:w-auto"
        data-testid="button-fiscal-precheck"
      >
        {running ? (
          <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="me-2 h-4 w-4" aria-hidden="true" />
        )}
        Run the pre-check
      </Button>
      {refusal && (
        <p className="text-sm text-destructive" role="alert" data-testid="error-fiscal-precheck">
          {refusal.serverMessage || refusal.message}
        </p>
      )}
      {check && (
        <ul className="space-y-1" data-testid="fiscal-precheck-result">
          <CheckLine
            ok={check.balanced}
            label={
              check.balanced ? "Trial balance balanced" : `Trial balance not balanced: difference ${check.difference}`
            }
            testId="check-trial-balance"
          />
          <CheckLine
            ok={check.retainedEarnings}
            label={check.retainedEarnings ? "RETAINED_EARNINGS present" : "RETAINED_EARNINGS missing (step 1)"}
            testId="check-retained-earnings"
          />
          <CheckLine
            ok={check.unknownTypeBalances.length === 0}
            label={
              check.unknownTypeBalances.length === 0
                ? "No balance on an account of unknown type"
                : `Accounts of unknown type with a balance: ${check.unknownTypeBalances.map((account) => account.name).join(", ")}`
            }
            testId="check-unknown-types"
          />
        </ul>
      )}
      {check && !ready && (
        <p className="text-sm text-muted-foreground">Fix the failed checks before closing: the close refuses them.</p>
      )}
      <Button
        variant={ready ? "default" : "outline"}
        onClick={() => setFlowOpen((open) => !open)}
        disabled={!canRun}
        className="w-full sm:w-auto"
        data-testid="button-open-fiscal-close"
      >
        {flowOpen ? "Hide the close and reopen flow" : "Open the close and reopen flow"}
      </Button>
      {flowOpen && (
        <Suspense fallback={<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}>
          <FiscalPeriodTab currentCompanyId={selectedCompany?.id} userRole={role} />
        </Suspense>
      )}
    </div>
  );
}
