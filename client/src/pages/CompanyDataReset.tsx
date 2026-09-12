import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Trash2, Shield, Undo2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { Company, LedgerAccount } from "@shared/schema";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export default function CompanyDataReset() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [clearStockOpeningBalances, setClearStockOpeningBalances] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);

  const { data: companies = [], isLoading: loadingCompanies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: accounts = [], isLoading: loadingAccounts } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompanyId],
    enabled: !!selectedCompanyId,
  });

  // All ledger accounts - suppliers are stored separately in the suppliers table
  const allLedgerAccounts = accounts;

  const resetMutation = useMutation({
    mutationFn: async () => {
      return modeApiRequest("POST", "/api/admin/company-data-reset", {
        companyId: parseInt(selectedCompanyId),
        accountIds: selectedAccountIds,
        clearStockOpeningBalances,
      });
    },
    onSuccess: () => {
      toast({ title: "Reset Complete", description: "Selected data has been cleared successfully" });
      setSelectedAccountIds([]);
      setClearStockOpeningBalances(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Reset Failed", description: error.message, variant: "destructive" });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      return modeApiRequest("POST", "/api/admin/undo-company-reset", {
        companyId: parseInt(selectedCompanyId),
      });
    },
    onSuccess: async (res) => {
      const data = (await res.json()) as { vouchersRestored?: number };
      toast({
        title: "Undo Complete",
        description: `Restored ${data.vouchersRestored || 0} vouchers successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Undo Failed", description: error.message, variant: "destructive" });
    },
  });

  const handleUndo = () => {
    setUndoDialogOpen(true);
  };

  const confirmUndo = () => {
    setUndoDialogOpen(false);
    undoMutation.mutate();
  };

  const toggleAccount = (accountId: number) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    );
  };

  const selectAll = () => {
    setSelectedAccountIds(allLedgerAccounts.map((a) => a.id));
  };

  const clearSelection = () => {
    setSelectedAccountIds([]);
  };

  const handleReset = () => {
    setConfirmDialogOpen(true);
  };

  const confirmReset = () => {
    setConfirmDialogOpen(false);
    resetMutation.mutate();
  };

  if (loadingCompanies) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <PageHeader
          title="Company Data Reset"
          subtitle="Clear vouchers and opening balances for selected accounts. Supplier balances are preserved."
        />
      </div>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Warning: Destructive Action
          </CardTitle>
          <CardDescription>
            This will delete ALL vouchers (including offloaded containers) and clear opening balances for selected
            accounts.
            <strong className="text-foreground">
              {" "}
              Only OTW (On The Way) container Purchase vouchers will be preserved.
            </strong>{" "}
            Supplier balances are also preserved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">Select Company</label>
            <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
              <SelectTrigger data-testid="select-company">
                <SelectValue placeholder="Choose a company..." />
              </SelectTrigger>
              <SelectContent>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id.toString()}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedCompanyId && (
            <>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Select Accounts to Clear</label>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={selectAll}>
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={clearSelection}>
                      Clear
                    </Button>
                  </div>
                </div>

                {loadingAccounts ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <div className="space-y-4">
                    <div className="bg-green-50 dark:bg-green-950/30 p-3 rounded-md border border-green-200 dark:border-green-800">
                      <div className="flex items-center gap-2 mb-2">
                        <Shield className="h-4 w-4 text-green-600" />
                        <span className="text-sm font-medium text-green-700 dark:text-green-400">
                          Protected: Supplier Balances
                        </span>
                      </div>
                      <p className="text-xs text-green-600 dark:text-green-500">
                        Supplier balances are stored separately and will NOT be affected by this reset.
                      </p>
                    </div>

                    <div className="border rounded-md max-h-96 overflow-y-auto">
                      {allLedgerAccounts.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">No accounts found</p>
                      ) : (
                        <div className="divide-y">
                          {allLedgerAccounts.map((account) => (
                            <div key={account.id} className="flex items-center gap-3 p-3 hover:bg-muted/50">
                              <Checkbox
                                checked={selectedAccountIds.includes(account.id)}
                                onCheckedChange={() => toggleAccount(account.id)}
                                data-testid={`checkbox-account-${account.id}`}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs text-muted-foreground">{account.code}</span>
                                  <span className="text-sm truncate">{account.name}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">
                                    {account.accountType}
                                  </Badge>
                                  {account.openingBalance && parseFloat(account.openingBalance) !== 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                      Opening: {account.openingBalanceSide} {account.openingBalance}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 p-3 border rounded-md">
                <Checkbox
                  checked={clearStockOpeningBalances}
                  onCheckedChange={(checked) => setClearStockOpeningBalances(!!checked)}
                  data-testid="checkbox-stock-opening"
                />
                <div>
                  <label className="text-sm font-medium">Clear Stock Item Opening Balances</label>
                  <p className="text-xs text-muted-foreground">
                    Reset openingQty, openingRate, openingValue for all stock items in this company
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <div className="text-sm text-muted-foreground">{selectedAccountIds.length} account(s) selected</div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleUndo}
                    disabled={undoMutation.isPending}
                    data-testid="button-undo"
                  >
                    <Undo2 className="h-4 w-4 mr-2" />
                    {undoMutation.isPending ? "Restoring..." : "Undo Last Reset"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleReset}
                    disabled={
                      (selectedAccountIds.length === 0 && !clearStockOpeningBalances) || resetMutation.isPending
                    }
                    data-testid="button-reset"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {resetMutation.isPending ? "Resetting..." : "Reset Selected Data"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        title="Are you absolutely sure?"
        tone="destructive"
        confirmText="Yes, Reset Data"
        onConfirm={confirmReset}
        description={
          <div className="space-y-2">
            <p>This will:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Delete ALL vouchers including offloaded container vouchers for this company</li>
              <li>Clear opening balances for the {selectedAccountIds.length} selected account(s)</li>
              {clearStockOpeningBalances && <li>Reset stock item opening balances to zero</li>}
            </ul>
            <p className="font-medium mt-2 text-success">
              Only OTW (On The Way) container Purchase vouchers will be preserved. Supplier balances will also be
              preserved.
            </p>
            <p className="text-sm">
              You can use "Undo Last Reset" to restore deleted vouchers (but not opening balances).
            </p>
          </div>
        }
      />

      <ConfirmDialog
        open={undoDialogOpen}
        onOpenChange={setUndoDialogOpen}
        title="Restore Deleted Vouchers?"
        confirmText="Yes, Restore Vouchers"
        onConfirm={confirmUndo}
        description="This will restore all previously deleted vouchers for this company. Note: Opening balances that were cleared cannot be restored automatically."
      />
    </div>
  );
}
