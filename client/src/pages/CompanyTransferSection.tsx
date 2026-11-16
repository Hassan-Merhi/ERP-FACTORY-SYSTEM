// Extracted from ./CompanyTransfer.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Undo2, Zap } from "lucide-react";
import { MODULES, MODULE_LABELS, formatUsdBase, useCompanyTransferState } from "./useCompanyTransferState";

export function CompanyTransferSection({
  accountOptions,
  addingModule,
  autoConfigQueries,
  fromAccounts,
  handleSaveRule,
  isLoading,
  openAddRule,
  otherCompanies,
  ruleCashAccountIds,
  ruleDestAccountId,
  ruleDestAccounts,
  ruleDestCompanyId,
  ruleEnabled,
  saveRuleMutation,
  setAddingModule,
  setDeleteConfirmRuleId,
  setRuleDestAccountId,
  setRuleDestCompanyId,
  setRuleEnabled,
  setUndoTarget,
  toggleCashAccount,
  transfers,
}: Pick<
  ReturnType<typeof useCompanyTransferState>,
  | "accountOptions"
  | "addingModule"
  | "autoConfigQueries"
  | "fromAccounts"
  | "handleSaveRule"
  | "isLoading"
  | "openAddRule"
  | "otherCompanies"
  | "ruleCashAccountIds"
  | "ruleDestAccountId"
  | "ruleDestAccounts"
  | "ruleDestCompanyId"
  | "ruleEnabled"
  | "saveRuleMutation"
  | "setAddingModule"
  | "setDeleteConfirmRuleId"
  | "setRuleDestAccountId"
  | "setRuleDestCompanyId"
  | "setRuleEnabled"
  | "setUndoTarget"
  | "toggleCashAccount"
  | "transfers"
>) {
  return (
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
                            <SelectValue placeholder={ruleDestCompanyId ? "Select account" : "Select company first"} />
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
                    <TableCell className="font-mono text-sm font-semibold">{formatUsdBase(transfer.amount)}</TableCell>
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
  );
}
