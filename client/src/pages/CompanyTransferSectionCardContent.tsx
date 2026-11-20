import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./CompanyTransferSection.tsx
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import { MODULES, MODULE_LABELS, useCompanyTransferState } from "./useCompanyTransferState";

export function CompanyTransferSectionCardContent({
  accountOptions,
  addingModule,
  autoConfigQueries,
  fromAccounts,
  handleSaveRule,
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
  toggleCashAccount,
}: Pick<
  Pick<
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
    | "refetchTransfers"
    | "transfersError"
  >,
  | "accountOptions"
  | "addingModule"
  | "autoConfigQueries"
  | "fromAccounts"
  | "handleSaveRule"
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
  | "toggleCashAccount"
>) {
  return (
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
                        <span className="font-medium">{rule.destCompanyName ?? `Company #${rule.destCompanyId}`}</span>
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
                    <UnifiedAccountPicker
                      options={accountOptions(ruleDestAccounts).map((account) => ({
                        value: String(account.id),
                        name: account.name,
                      }))}
                      value={ruleDestAccountId}
                      onChange={setRuleDestAccountId}
                      placeholder={ruleDestCompanyId ? "Select account" : "Select company first"}
                      disabled={!ruleDestCompanyId}
                      testId={`select-rule-dest-account-${module}`}
                    />
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
  );
}
