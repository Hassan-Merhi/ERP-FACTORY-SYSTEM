import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";
import type { LedgerAccount } from "@shared/schema";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Calculator, ChevronUp, ChevronDown } from "lucide-react";

interface ZeroBalancesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: number;
}

export function ZeroBalancesDialog({ open, onOpenChange, companyId }: ZeroBalancesDialogProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<number[]>([]);

  const { data: accounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", companyId],
    enabled: !!companyId && open,
  });

  const mutation = useMutation({
    mutationFn: async (accountIds: number[]) => {
      const res = await apiRequest("POST", "/api/ledger-accounts/zero-balances", { accountIds });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to zero balances");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Opening balances zeroed for ${data.count} account(s)`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      onOpenChange(false);
      setSelected([]);
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Error",
        description: error.message || "Failed to zero balances",
        variant: "destructive",
      });
    },
  });

  const nonZeroAccounts = accounts.filter((a) => !a.deletedAt && a.active && parseFloat(a.openingBalance || "0") !== 0);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-red-500" />
            Zero Account Balances
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4 text-foreground">
              <p className="text-muted-foreground">
                Select accounts to zero their opening balances. This gives you a fresh start for a new period while
                keeping all historical vouchers intact.
              </p>

              <div className="flex items-center justify-between border-b pb-2">
                <div className="flex items-center gap-4">
                  <Checkbox
                    checked={nonZeroAccounts.length > 0 && selected.length === nonZeroAccounts.length}
                    onCheckedChange={(checked) => {
                      if (checked) setSelected(nonZeroAccounts.map((a) => a.id));
                      else setSelected([]);
                    }}
                  />
                  <Label className="font-medium">Select All with Non-Zero Balances</Label>
                </div>
                <Badge variant="outline">{selected.length} selected</Badge>
              </div>

              <div className="max-h-96 overflow-y-auto border rounded">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12"></TableHead>
                      <TableHead>Account Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Opening Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts
                      .filter((account) => !account.deletedAt && account.active)
                      .sort((a, b) => a.accountType.localeCompare(b.accountType) || a.name.localeCompare(b.name))
                      .map((account) => {
                        const balance = parseFloat(account.openingBalance || "0");
                        const hasBalance = balance !== 0;
                        return (
                          <TableRow key={account.id} className={hasBalance ? "" : "opacity-50"}>
                            <TableCell>
                              <Checkbox
                                checked={selected.includes(account.id)}
                                disabled={!hasBalance}
                                onCheckedChange={(checked) => {
                                  if (checked) setSelected([...selected, account.id]);
                                  else setSelected(selected.filter((id) => id !== account.id));
                                }}
                              />
                            </TableCell>
                            <TableCell className="font-medium">{account.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{account.accountType}</Badge>
                            </TableCell>
                            <TableCell className="text-right">{formatNumber(balance)}</TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutation.mutate(selected)}
            disabled={mutation.isPending || selected.length === 0}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending ? "Processing..." : `Zero ${selected.length} Account(s)`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface InitializeBalancesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BalanceComponent = {
  name: string;
  value: number | string | null;
};

type CompanyBalanceResult = {
  companyId: number;
  companyName: string;
  imbalance?: number | string | null;
  message?: string;
  components?: {
    assets?: BalanceComponent[];
    liabilities?: BalanceComponent[];
  };
};

type InitializeBalancesResult = {
  message: string;
  results?: CompanyBalanceResult[];
};

export function InitializeBalancesDialog({ open, onOpenChange }: InitializeBalancesDialogProps) {
  const { toast } = useToast();
  const [result, setResult] = useState<InitializeBalancesResult | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/initialize-accounting-balances", {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to initialize balances");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: "Success", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setResult(null);
      }}
    >
      <AlertDialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Initialize Accounting Balances</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-foreground">
              {!result ? (
                <p className="text-muted-foreground">
                  This will create Owner's Capital accounts for each company to balance the Import Cycle. This action
                  cannot be easily undone.
                </p>
              ) : (
                <div className="space-y-4 mt-4">
                  <div className="font-medium">{result.message}</div>
                  {result.results?.map((r: CompanyBalanceResult) => (
                    <div key={r.companyId} className="p-3 border rounded-md space-y-2">
                      <div className="font-medium">{r.companyName}</div>
                      <div className="text-sm">Imbalance: ${formatNumber(Number(r.imbalance || 0))}</div>
                      <div className="text-sm">{r.message}</div>

                      {r.components && (
                        <div className="text-sm mt-3 border-t pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full justify-between"
                            onClick={() => setExpandedId(expandedId === r.companyId ? null : r.companyId)}
                          >
                            <span>View Calculation Breakdown</span>
                            {expandedId === r.companyId ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </Button>
                          {expandedId === r.companyId && (
                            <div className="mt-2 grid grid-cols-2 gap-4 p-2 bg-muted/50 rounded">
                              <div>
                                <div className="font-medium text-green-600 dark:text-green-400 mb-1">
                                  Assets (Debit)
                                </div>
                                {r.components.assets?.map((c: BalanceComponent, i: number) => (
                                  <div key={i} className="flex justify-between text-xs">
                                    <span>{c.name}</span>
                                    <span>${formatNumber(Number(c.value ?? 0))}</span>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <div className="font-medium text-red-600 dark:text-red-400 mb-1">
                                  Liabilities (Credit)
                                </div>
                                {r.components.liabilities?.map((c: BalanceComponent, i: number) => (
                                  <div key={i} className="flex justify-between text-xs">
                                    <span>{c.name}</span>
                                    <span>${formatNumber(Number(c.value ?? 0))}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {!result && (
            <AlertDialogAction onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? "Processing..." : "Initialize All Companies"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
