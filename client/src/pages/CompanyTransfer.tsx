import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, keyStartsWith, queryClient } from "@/lib/queryClient";
import { companyKeys } from "@/lib/queryKeys";
import { useCompany } from "@/contexts/CompanyContext";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Undo2, Zap } from "lucide-react";

interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

interface Transfer {
  id: number;
  fromCompanyId: number;
  toCompanyId: number;
  fromCompanyName: string;
  toCompanyName: string;
  fromAccountName: string;
  toAccountName: string;
  amount: string;
  transferDate: string;
  description: string | null;
  createdAt: string;
}

interface AutoTransferConfig {
  id: number;
  companyId: number;
  module: string;
  destCompanyId: number;
  destLedgerAccountId: number;
  sourceCashAccountIds: number[];
  enabled: boolean;
  destCompanyName?: string | null;
  destAccountName?: string | null;
  sourceAccountNames?: { id: number; name: string }[];
}

const MODULE_LABELS: Record<string, string> = {
  PROPERTIES: "Properties Rentals",
  ERP: "ERP Rentals",
  FACTORY: "Factory Rentals",
};

const MODULE_PREFIXES: Record<string, string> = {
  PROPERTIES: "/api/properties/rental",
  ERP: "/api/erp/rental",
  FACTORY: "/api/factory/rental",
};

const MODULES = ["PROPERTIES", "ERP", "FACTORY"] as const;

// Transfer history stores the common USD accounting base, never a current
// Kwacha translation. Formatting through the active company's currency context
// mislabeled parent and Zambia accounting balances on this screen.
const formatUsdBase = (value: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));

export default function CompanyTransfer() {
  const { companies, selectedCompany: currentCompany } = useCompany();
  const { toast } = useToast();

  const [undoTarget, setUndoTarget] = useState<Transfer | null>(null);
  const [addingModule, setAddingModule] = useState<string | null>(null);
  const [ruleDestCompanyId, setRuleDestCompanyId] = useState("");
  const [ruleDestAccountId, setRuleDestAccountId] = useState("");
  const [ruleCashAccountIds, setRuleCashAccountIds] = useState<number[]>([]);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [deleteConfirmRuleId, setDeleteConfirmRuleId] = useState<{ id: number; module: string } | null>(null);

  const fromCompanyId = currentCompany?.id;
  const otherCompanies = useMemo(
    () => companies.filter((company) => company.id !== fromCompanyId),
    [companies, fromCompanyId]
  );

  const { data: fromAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyKeys.companyAccounts(fromCompanyId, fromCompanyId),
    enabled: !!fromCompanyId,
  });

  const { data: ruleDestAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyKeys.companyAccounts(fromCompanyId, ruleDestCompanyId || null),
    enabled: !!fromCompanyId && !!ruleDestCompanyId,
  });

  const transferKey = companyKeys.simpleTransfers(fromCompanyId);
  const { data: transfers = [], isLoading } = useQuery<Transfer[]>({
    queryKey: transferKey,
    enabled: !!fromCompanyId,
  });

  const cfgProperties = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.PROPERTIES),
    enabled: !!fromCompanyId,
  });
  const cfgErp = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.ERP),
    enabled: !!fromCompanyId,
  });
  const cfgFactory = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.FACTORY),
    enabled: !!fromCompanyId,
  });
  const autoConfigQueries = [cfgProperties, cfgErp, cfgFactory];

  const undoMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/simple-company-transfer/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: transferKey });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/accounts"), refetchType: "active" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/stats"), refetchType: "active" });
      toast({ title: "Transfer reversed", description: "Both company balances were restored." });
      setUndoTarget(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Undo failed", description: error.message, variant: "destructive" });
      setUndoTarget(null);
    },
  });

  const saveRuleMutation = useMutation({
    mutationFn: ({ module, body }: { module: string; body: object }) =>
      apiRequest("POST", `${MODULE_PREFIXES[module]}/auto-transfer-config`, body),
    onSuccess: (_, { module }) => {
      queryClient.invalidateQueries({
        queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES[module]),
      });
      toast({ title: "Rule added", description: "Auto-transfer rule is now active." });
      setAddingModule(null);
      setRuleDestCompanyId("");
      setRuleDestAccountId("");
      setRuleCashAccountIds([]);
      setRuleEnabled(true);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: ({ module, id }: { module: string; id: number }) =>
      apiRequest("DELETE", `${MODULE_PREFIXES[module]}/auto-transfer-config/${id}`),
    onSuccess: (_, { module }) => {
      queryClient.invalidateQueries({
        queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES[module]),
      });
      toast({ title: "Rule removed", description: "Auto-transfer rule deleted." });
      setDeleteConfirmRuleId(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      setDeleteConfirmRuleId(null);
    },
  });

  const openAddRule = (module: string) => {
    setAddingModule(module);
    setRuleDestCompanyId("");
    setRuleDestAccountId("");
    setRuleCashAccountIds([]);
    setRuleEnabled(true);
  };

  const toggleCashAccount = (id: number) => {
    setRuleCashAccountIds((previous) =>
      previous.includes(id) ? previous.filter((accountId) => accountId !== id) : [...previous, id]
    );
  };

  const handleSaveRule = () => {
    if (!addingModule || !ruleDestCompanyId || !ruleDestAccountId) {
      toast({
        title: "Missing fields",
        description: "Select destination company and account.",
        variant: "destructive",
      });
      return;
    }

    saveRuleMutation.mutate({
      module: addingModule,
      body: {
        destCompanyId: Number.parseInt(ruleDestCompanyId, 10),
        destLedgerAccountId: Number.parseInt(ruleDestAccountId, 10),
        sourceCashAccountIds: ruleCashAccountIds,
        enabled: ruleEnabled,
      },
    });
  };

  const accountOptions = (accounts: LedgerAccount[]) =>
    accounts.filter((account) => account.code !== "TRANSFER-CLEARING");

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="shrink-0 border-b px-6 py-4">
        <PageHeader
          title="Company Transfer"
          subtitle="Move a balance from one company to another. The amount is removed from the source and added to the destination."
        />
      </div>

      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-amber-500" />
              Automatic Transfer Rules
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              When a rental payment is recorded, all matching rules fire automatically. Add multiple rules per module to
              route different cash accounts to different destinations.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {MODULES.map((module, index) => {
              const rules = autoConfigQueries[index].data ?? [];
              const isAdding = addingModule === module;

              return (
                <div key={module} className="space-y-2 rounded-md border p-3" data-testid={`rule-section-${module}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{MODULE_LABELS[module]}</span>
                      <Badge variant={rules.length > 0 ? "default" : "outline"} className="text-xs">
                        {rules.length === 0 ? "No rules" : `${rules.length} rule${rules.length > 1 ? "s" : ""}`}
                      </Badge>
                    </div>
                    {!isAdding ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openAddRule(module)}
                        data-testid={`button-add-rule-${module}`}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Add Rule
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setAddingModule(null)}>
                        Cancel
                      </Button>
                    )}
                  </div>

                  {rules.length > 0 && (
                    <div className="space-y-1.5">
                      {rules.map((rule) => (
                        <div
                          key={rule.id}
                          className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
                          data-testid={`rule-item-${rule.id}`}
                        >
                          <div className="min-w-0 space-y-0.5 text-sm">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={rule.enabled ? "default" : "secondary"} className="text-xs">
                                {rule.enabled ? "Active" : "Paused"}
                              </Badge>
                              <span className="text-muted-foreground">→</span>
                              <span className="font-medium">
                                {rule.destCompanyName ?? `Company #${rule.destCompanyId}`}
                              </span>
                              {rule.destAccountName && (
                                <span className="text-muted-foreground">/ {rule.destAccountName}</span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Triggers on:{" "}
                              {(rule.sourceCashAccountIds ?? []).length > 0 ? (
                                (rule.sourceAccountNames ?? []).map((account) => account.name).join(", ") ||
                                `${rule.sourceCashAccountIds.length} account(s)`
                              ) : (
                                <em>all cash accounts</em>
                              )}
                            </p>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteConfirmRuleId({ id: rule.id, module })}
                            data-testid={`button-delete-rule-${rule.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {isAdding && (
                    <div className="mt-2 space-y-3 border-t pt-2">
                      <p className="text-xs font-medium text-muted-foreground">New rule</p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Destination Company</Label>
                          <Select
                            value={ruleDestCompanyId}
                            onValueChange={(value) => {
                              setRuleDestCompanyId(value);
                              setRuleDestAccountId("");
                            }}
                            data-testid={`select-rule-dest-company-${module}`}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select company" />
                            </SelectTrigger>
                            <SelectContent>
                              {otherCompanies.map((company) => (
                                <SelectItem key={company.id} value={String(company.id)}>
                                  {company.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Destination Account</Label>
                          <Select
                            value={ruleDestAccountId}
                            onValueChange={setRuleDestAccountId}
                            disabled={!ruleDestCompanyId}
                            data-testid={`select-rule-dest-account-${module}`}
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={ruleDestCompanyId ? "Select account" : "Select company first"}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {accountOptions(ruleDestAccounts).map((account) => (
                                <SelectItem key={account.id} value={String(account.id)}>
                                  {account.name}
                                  <span className="ml-1 text-xs text-muted-foreground">({account.accountType})</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          Trigger on cash accounts
                          <span className="ml-1 font-normal text-muted-foreground">
                            (leave all unchecked = every cash account)
                          </span>
                        </Label>
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border p-2">
                          {accountOptions(fromAccounts).map((account) => (
                            <label
                              key={account.id}
                              className="flex cursor-pointer select-none items-center gap-1.5 text-sm"
                              data-testid={`checkbox-cash-account-${account.id}`}
                            >
                              <input
                                type="checkbox"
                                checked={ruleCashAccountIds.includes(account.id)}
                                onChange={() => toggleCashAccount(account.id)}
                                className="accent-primary"
                              />
                              {account.name}
                            </label>
                          ))}
                          {accountOptions(fromAccounts).length === 0 && (
                            <span className="text-xs text-muted-foreground">No accounts found</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {ruleCashAccountIds.length === 0
                            ? "All cash accounts will trigger this rule."
                            : `Only when payment uses: ${accountOptions(fromAccounts)
                                .filter((account) => ruleCashAccountIds.includes(account.id))
                                .map((account) => account.name)
                                .join(", ")}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Switch
                          checked={ruleEnabled}
                          onCheckedChange={setRuleEnabled}
                          data-testid={`switch-rule-enabled-${module}`}
                        />
                        <Label className="text-sm">{ruleEnabled ? "Enabled" : "Paused"}</Label>
                      </div>
                      <Button
                        size="sm"
                        onClick={handleSaveRule}
                        disabled={saveRuleMutation.isPending}
                        data-testid={`button-save-rule-${module}`}
                      >
                        {saveRuleMutation.isPending ? "Saving…" : "Add Rule"}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Transfer History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : transfers.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No transfers yet.</p>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>From Account</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>To Account</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead className="text-right">Undo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfers.map((transfer) => (
                    <TableRow key={transfer.id} data-testid={`row-transfer-${transfer.id}`}>
                      <TableCell className="text-sm">{transfer.transferDate}</TableCell>
                      <TableCell className="text-sm font-medium">{transfer.fromCompanyName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{transfer.fromAccountName}</TableCell>
                      <TableCell className="text-sm font-medium">{transfer.toCompanyName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{transfer.toAccountName}</TableCell>
                      <TableCell className="font-mono text-sm font-semibold">
                        {formatUsdBase(transfer.amount)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{transfer.description ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setUndoTarget(transfer)}
                          data-testid={`button-undo-${transfer.id}`}
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={!!undoTarget} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse this transfer?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoTarget && (
                <>
                  This will reverse the <strong>{formatUsdBase(undoTarget.amount)}</strong> transfer from{" "}
                  <strong>{undoTarget.fromCompanyName}</strong> to <strong>{undoTarget.toCompanyName}</strong> on{" "}
                  <strong>{undoTarget.transferDate}</strong>.
                  <br />
                  <br />
                  Both company balances will return to their prior values and the transfer history entry will be
                  removed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => undoTarget && undoMutation.mutate(undoTarget.id)}
              data-testid="button-confirm-undo"
            >
              {undoMutation.isPending ? "Reversing…" : "Yes, Reverse It"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteConfirmRuleId} onOpenChange={(open) => !open && setDeleteConfirmRuleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this auto-transfer rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This rule will be deleted. Payments already processed are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteConfirmRuleId && deleteRuleMutation.mutate(deleteConfirmRuleId)}
              data-testid="button-confirm-delete-rule"
            >
              {deleteRuleMutation.isPending ? "Removing…" : "Remove Rule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
