import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle, Loader2, Zap, ShieldCheck, Landmark, ArrowLeftRight } from "lucide-react";
import {
  requestSetupConfirmation,
  IntercompanyReadinessRow,
  type GoldenCoastRoleStatus,
  type GoldenCoastSetupStatus,
} from "./SpSetupPanelParts";
import { useSpSetupPanelState } from "./useSpSetupPanelState";

export default function SpSetupPanel() {
  const {
    isSpStatusLoading,
    status,
    isGoldenCoastStatusLoading,
    goldenCoastBase,
    goldenCoastScoped,
    setupMutation,
    goldenCoastMutation,
  } = useSpSetupPanelState();

  if (isSpStatusLoading || isGoldenCoastStatusLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const requiredAccountCount = status?.requiredAccountCount ?? status?.spAccounts?.length ?? 0;
  const supplierLinkGapCount = Number(status?.supplierVoucherLinkGapCount ?? 0);
  const goldenCoast: GoldenCoastSetupStatus | undefined = goldenCoastScoped ?? goldenCoastBase ?? status?.goldenCoast;
  const goldenCoastRoles: GoldenCoastRoleStatus[] = goldenCoast?.roles ?? [];
  const phase13 = goldenCoast?.phase13;
  const goldenCoastReady = goldenCoast?.isConfigured === true && phase13?.isConfigured === true;

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">Chart of Accounts</CardTitle>
              <CardDescription className="text-xs mt-1">
                {requiredAccountCount} accounts required for the complete SP accounting flow
              </CardDescription>
            </div>
            {status?.isConfigured ? (
              <Badge variant="outline" className="text-green-600 border-green-600/40">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-amber-600 border-amber-600/40">
                <AlertCircle className="h-3 w-3 mr-1" /> Not set up
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.spAccounts && status.spAccounts.length > 0 && (
            <div className="grid gap-1.5">
              {status.spAccounts.map((acct) => (
                <div
                  key={acct.id}
                  className="flex items-center justify-between text-sm py-1 border-b border-border/40 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground w-24">{acct.code}</span>
                    <span>{acct.name}</span>
                    {acct.isHidden && (
                      <Badge variant="secondary" className="text-xs py-0">
                        hidden
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{acct.accountType}</span>
                </div>
              ))}
            </div>
          )}

          {status?.locations && status.locations.length > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Warehouse: </span>
              <span className="font-medium">{status.locations[0].name}</span>
            </div>
          )}

          {status?.bankAccounts?.length === 0 && (
            <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded-md p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                No bank accounts found. Add at least one bank account for prepaid payments and sales receipts.
              </span>
            </div>
          )}

          {supplierLinkGapCount > 0 ? (
            <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded-md p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {supplierLinkGapCount} Goods-OTW voucher{supplierLinkGapCount === 1 ? "" : "s"} need supplier-ledger
                repair. Re-run Setup to fix them safely.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 rounded-md p-3">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Container suppliers and Goods-OTW voucher headers are synchronized.</span>
            </div>
          )}

          <Button
            onClick={async () => {
              const payload = await requestSetupConfirmation(
                status?.isConfigured ? "Repair and re-run Supplier Partner setup" : "Initialize Supplier Partner setup"
              );
              if (payload) setupMutation.mutate(payload);
            }}
            disabled={setupMutation.isPending}
            data-testid="button-sp-setup"
          >
            {setupMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            {status?.isConfigured ? "Repair & Re-run Setup" : "Initialize Setup"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">{releaseDebtEnglish("Golden Coast Accounting Readiness")}</CardTitle>
              <CardDescription className="text-xs mt-1">
                {goldenCoast?.configuredRoleCount ?? 0} of {goldenCoast?.requiredRoleCount ?? 0} balance-sheet roles
                plus the reciprocal HADI intercompany pair
              </CardDescription>
            </div>
            {goldenCoastReady ? (
              <Badge variant="outline" className="text-green-600 border-green-600/40">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Ready
              </Badge>
            ) : (
              <Badge variant="outline" className="text-amber-600 border-amber-600/40">
                <AlertCircle className="h-3 w-3 mr-1" /> Action needed
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {goldenCoastRoles.length > 0 && (
            <div className="grid gap-1.5">
              {goldenCoastRoles.map((role) => (
                <div
                  key={role.role}
                  className="flex items-start justify-between gap-3 text-sm py-1.5 border-b border-border/40 last:border-0"
                  data-testid={`row-gc-role-${role.role}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {role.status === "ok" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                      )}
                      <span className="font-medium">{role.name ?? role.expectedName}</span>
                      <span className="font-mono text-xs text-muted-foreground">{role.code ?? "not created"}</span>
                      {role.openingBalanceTargetUsd && (
                        <Badge variant="secondary" className="text-xs py-0">
                          opening ${Number(role.openingBalanceTargetUsd).toLocaleString()}
                        </Badge>
                      )}
                      {role.ownershipSharePct && (
                        <Badge variant="secondary" className="text-xs py-0">
                          {role.ownershipSharePct}% share
                        </Badge>
                      )}
                    </div>
                    {role.issues?.length > 0 && (
                      <p className="text-xs text-amber-600 mt-0.5">{role.issues.join(" · ")}</p>
                    )}
                    {role.warnings?.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">{role.warnings.join(" · ")}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {role.accountType ?? role.expectedAccountType}
                  </span>
                </div>
              ))}
            </div>
          )}

          {phase13 && (
            <div className="rounded-md border p-3 space-y-2" data-testid="gc-phase13-intercompany-readiness">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ArrowLeftRight className="h-4 w-4" /> {releaseDebtEnglish("HADI intercompany pair")}
                </div>
                <span className="text-xs text-muted-foreground">{phase13.parentCompanyName}</span>
              </div>
              <IntercompanyReadinessRow account={phase13.goldenCoastAccount} />
              {phase13.hadiAccount ? (
                <IntercompanyReadinessRow account={phase13.hadiAccount} />
              ) : (
                <p className="text-xs text-amber-600">
                  {releaseDebtEnglish(
                    "HADI-side readiness needs parent-company authorization. Re-run Golden Coast setup to verify and repair it."
                  )}
                </p>
              )}
              {phase13.blockers?.length > 0 && <p className="text-xs text-amber-600">{phase13.blockers.join(" · ")}</p>}
            </div>
          )}

          <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
            <p>
              Fresh Start-contributed inventory is an in-kind contribution and does not consume Hassan's $100,000
              funding balance.
            </p>
            <p>
              Cash-funded inventory plus Container Reserve consume Hassan funding. The unused balance becomes Hassan
              Savings through settlement; it is not added as extra capital.
            </p>
          </div>

          <Button
            onClick={async () => {
              const payload = await requestSetupConfirmation(
                goldenCoastReady
                  ? "Re-verify Golden Coast and HADI accounting"
                  : "Provision Golden Coast and HADI accounting",
                phase13?.parentCompanyId
              );
              if (payload) goldenCoastMutation.mutate(payload);
            }}
            disabled={goldenCoastMutation.isPending || !phase13?.parentCompanyId}
            data-testid="button-gc-setup"
          >
            {goldenCoastMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Landmark className="h-4 w-4 mr-2" />
            )}
            {goldenCoastReady ? "Re-verify Golden Coast & HADI" : "Provision / Repair Golden Coast & HADI"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">SP POS Accounting Policy</CardTitle>
              <CardDescription className="text-xs mt-1">
                The dedicated Supplier Partner sales flow applies this entry automatically.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-green-600 border-green-600/40">
              <ShieldCheck className="h-3 w-3 mr-1" /> Automatic
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
            <p>
              <span className="font-medium">Dr Cash / Bank</span> = full customer payment
            </p>
            <p>
              <span className="font-medium">Cr GC Sales Cash</span> (formerly Supplier Cash Payable) = full customer
              payment
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Cost of goods and realized profit are retained on SP sale lines and stock movements for reporting. They are
            not posted as extra voucher lines, preventing the sale amount from being double-counted.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
