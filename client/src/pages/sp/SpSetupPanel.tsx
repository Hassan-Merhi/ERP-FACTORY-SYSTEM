import type { ClientErrorLike } from "@/lib/clientError";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle, Loader2, Zap, ShieldCheck, Landmark, ArrowLeftRight } from "lucide-react";

interface GoldenCoastRoleStatus {
  role: string;
  expectedName: string;
  expectedAccountType: string;
  status: "ok" | "missing" | "needs_repair";
  code: string | null;
  name: string | null;
  accountType: string | null;
  openingBalanceTargetUsd: string | null;
  ownershipSharePct: string | null;
  issues: string[];
  warnings: string[];
}

interface GoldenCoastIntercompanyAccountStatus {
  role: string;
  companyId: number;
  subType: string;
  expectedName: string;
  status: "ok" | "missing" | "needs_repair" | "ambiguous";
  accountId: number | null;
  name: string | null;
  accountType: string | null;
  issues: string[];
}

interface GoldenCoastPhase13Status {
  isConfigured: boolean;
  parentCompanyId: number;
  parentCompanyName: string;
  parentAuthorized: boolean;
  goldenCoastAccount: GoldenCoastIntercompanyAccountStatus;
  hadiAccount: GoldenCoastIntercompanyAccountStatus | null;
  blockers: string[];
}

interface GoldenCoastSetupStatus {
  isConfigured: boolean;
  requiredRoleCount: number;
  configuredRoleCount: number;
  roles: GoldenCoastRoleStatus[];
  phase13?: GoldenCoastPhase13Status;
}

interface SpAccount {
  id: number;
  code?: string;
  name?: string;
  isHidden?: boolean;
  accountType?: string;
}

interface SpSetupStatus {
  requiredAccountCount?: number;
  spAccounts?: SpAccount[];
  supplierVoucherLinkGapCount?: number;
  isConfigured?: boolean;
  locations?: { name: string }[];
  bankAccounts?: unknown[];
  goldenCoast?: GoldenCoastSetupStatus;
}

interface SetupConfirmationPayload {
  confirmation: "CHANGE SP SETUP";
  reason: string;
  idempotencyKey: string;
  clientRequestId: string;
  targetCompanyId?: number;
}

function createFreshIdempotencyKey(scope: string): string {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
  return uuid ? `${scope}:${uuid}` : `${scope}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function requestSetupConfirmation(actionLabel: string, targetCompanyId?: number): SetupConfirmationPayload | null {
  if (typeof window === "undefined") return null;
  const confirmation = window.prompt(`${actionLabel}\n\nType exactly: CHANGE SP SETUP`);
  if (confirmation == null) return null;
  if (confirmation.trim() !== "CHANGE SP SETUP") {
    window.alert("Confirmation did not match. Type exactly: CHANGE SP SETUP");
    return null;
  }

  const reason =
    window.prompt("Enter a meaningful reason for this setup change (at least 5 characters):")?.trim() ?? "";
  if (reason.length < 5) {
    window.alert("A meaningful reason of at least 5 characters is required.");
    return null;
  }

  const idempotencyKey = createFreshIdempotencyKey("sp-setup");
  return {
    confirmation: "CHANGE SP SETUP",
    reason,
    idempotencyKey,
    clientRequestId: idempotencyKey,
    ...(targetCompanyId && targetCompanyId > 0 ? { targetCompanyId } : {}),
  };
}

function IntercompanyReadinessRow({ account }: { account: GoldenCoastIntercompanyAccountStatus }) {
  const ok = account.status === "ok";
  return (
    <div className="flex items-start justify-between gap-3 text-sm py-1.5 border-b border-border/40 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
          )}
          <span className="font-medium">{account.name ?? account.expectedName}</span>
          <span className="font-mono text-xs text-muted-foreground">{account.subType}</span>
        </div>
        {account.issues?.length > 0 && <p className="text-xs text-amber-600 mt-0.5">{account.issues.join(" · ")}</p>}
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{account.accountType ?? "Intercompany"}</span>
    </div>
  );
}

export default function SpSetupPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading: isSpStatusLoading } = useQuery<SpSetupStatus>({
    queryKey: ["/api/sp/setup/status"],
  });
  const { data: goldenCoastBase, isLoading: isGoldenCoastStatusLoading } = useQuery<GoldenCoastSetupStatus>({
    queryKey: ["/api/sp/setup/golden-coast/status"],
  });
  const parentCompanyId = Number(goldenCoastBase?.phase13?.parentCompanyId ?? 0);
  const scopedGoldenCoastStatusUrl =
    parentCompanyId > 0 ? `/api/sp/setup/golden-coast/status?targetCompanyId=${parentCompanyId}` : "";
  const { data: goldenCoastScoped } = useQuery<GoldenCoastSetupStatus>({
    queryKey: [scopedGoldenCoastStatusUrl],
    enabled: parentCompanyId > 0,
    retry: false,
  });

  const setupMutation = useMutation({
    mutationFn: async (payload: SetupConfirmationPayload) => {
      const response = await apiRequest("POST", "/api/sp/setup", payload);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });

      const messages: string[] = [];
      if (data.created?.length > 0) messages.push(`Created: ${data.created.join(", ")}.`);
      if (data.repairedSupplierVoucherLinks > 0) {
        messages.push(
          `Repaired ${data.repairedSupplierVoucherLinks} Goods-OTW voucher supplier link${
            data.repairedSupplierVoucherLinks === 1 ? "" : "s"
          }.`
        );
      }

      toast({
        title: "Supplier Partner setup complete",
        description: messages.join(" ") || "Accounts, warehouse, and supplier ledger links are already configured.",
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const goldenCoastMutation = useMutation({
    mutationFn: async (payload: SetupConfirmationPayload) => {
      const response = await apiRequest("POST", "/api/sp/setup/golden-coast", payload);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/golden-coast/status"] });
      if (scopedGoldenCoastStatusUrl) {
        queryClient.invalidateQueries({ queryKey: [scopedGoldenCoastStatusUrl] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });

      const messages: string[] = [];
      if (data.created?.length > 0) messages.push(`Created ${data.created.length} balance-sheet account(s).`);
      if (data.repaired?.length > 0) messages.push(`Repaired ${data.repaired.length} balance-sheet account(s).`);
      if (data.settingsChanged?.length > 0) messages.push(`Bound ${data.settingsChanged.join(", ")}.`);
      const intercompanyChanges = (data.intercompanyChanges ?? []).filter(
        (item: { action?: string }) => item.action && item.action !== "none"
      );
      if (intercompanyChanges.length > 0) {
        messages.push(
          `Provisioned/repaired ${intercompanyChanges.length} Golden Coast ↔ HADI intercompany account(s).`
        );
      }

      toast({
        title: releaseDebtEnglish("Golden Coast accounting setup complete"),
        description: messages.join(" ") || "Golden Coast and HADI accounting accounts were already configured.",
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

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
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                No bank accounts found. Add at least one bank account for prepaid payments and sales receipts.
              </span>
            </div>
          )}

          {supplierLinkGapCount > 0 ? (
            <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded-md p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                {supplierLinkGapCount} Goods-OTW voucher{supplierLinkGapCount === 1 ? "" : "s"} need supplier-ledger
                repair. Re-run Setup to fix them safely.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 rounded-md p-3">
              <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>Container suppliers and Goods-OTW voucher headers are synchronized.</span>
            </div>
          )}

          <Button
            onClick={() => {
              const payload = requestSetupConfirmation(
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
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
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
            onClick={() => {
              const payload = requestSetupConfirmation(
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
