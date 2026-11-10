import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Wallet, Package, FileText, Landmark } from "lucide-react";

import { calculateAbsoluteTotal, calculateCashTotal, formatSignedSmartCurrency, formatSmartCurrency } from "../accountMath";
import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

export function BalanceSectionsPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    accountsLoading,
    activeSection,
    assetAccounts,
    cashAccounts,
    liabilityAccounts,
    loansBanksAccounts,
    renderHierarchicalAccounts,
  } = analytics;
  const cashTotal = calculateCashTotal(cashAccounts);
  return (
    <>
      {activeSection === "assets" && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Package className="h-4 w-4" />
                </div>
                <h4 className="font-semibold text-base">Asset Accounts</h4>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total</p>
                <p className="text-2xl font-bold font-mono tabular-nums">
                  {formatSmartCurrency(calculateAbsoluteTotal(assetAccounts))}
                </p>
              </div>
            </div>
            {accountsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : assetAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No asset accounts found</p>
            ) : (
              <div className="table-responsive">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Account Name</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{renderHierarchicalAccounts(assetAccounts)}</TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">Total</TableCell>
                      <TableCell className="text-right font-bold font-mono">
                        {formatSmartCurrency(calculateAbsoluteTotal(assetAccounts))}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === "liabilities" && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                  <FileText className="h-4 w-4" />
                </div>
                <h4 className="font-semibold text-base">Liability Accounts</h4>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total</p>
                <p className="text-2xl font-bold font-mono tabular-nums">
                  {formatSmartCurrency(calculateAbsoluteTotal(liabilityAccounts))}
                </p>
              </div>
            </div>
            {accountsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : liabilityAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No liability accounts found</p>
            ) : (
              <div className="table-responsive">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Account Name</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{renderHierarchicalAccounts(liabilityAccounts)}</TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">Total</TableCell>
                      <TableCell className="text-right font-bold font-mono">
                        {formatSmartCurrency(calculateAbsoluteTotal(liabilityAccounts))}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === "cash" && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
                  <Wallet className="h-4 w-4" />
                </div>
                <h4 className="font-semibold text-base">Cash Accounts</h4>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total Cash</p>
                <p className={`text-2xl font-bold font-mono tabular-nums ${cashTotal < 0 ? "text-red-500 dark:text-red-400" : ""}`}>
                  {formatSignedSmartCurrency(cashTotal)}
                </p>
              </div>
            </div>
            {accountsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : cashAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No cash accounts found</p>
            ) : (
              <div className="table-responsive">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Account Name</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{renderHierarchicalAccounts(cashAccounts, true)}</TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">Total Cash</TableCell>
                      <TableCell className={`text-right font-bold font-mono ${cashTotal < 0 ? "text-red-500 dark:text-red-400" : ""}`}>
                        {formatSignedSmartCurrency(cashTotal)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === "loans-banks" && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <Landmark className="h-4 w-4" />
                </div>
                <h4 className="font-semibold text-base">Loans &amp; Bank Accounts</h4>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total Balance</p>
                <p className="text-2xl font-bold font-mono tabular-nums">
                  {formatSmartCurrency(calculateAbsoluteTotal(loansBanksAccounts))}
                </p>
              </div>
            </div>
            {accountsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : loansBanksAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No loan or bank accounts found</p>
            ) : (
              <div className="table-responsive">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Account Name</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{renderHierarchicalAccounts(loansBanksAccounts)}</TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">Total Balance</TableCell>
                      <TableCell className="text-right font-bold font-mono">
                        {formatSmartCurrency(calculateAbsoluteTotal(loansBanksAccounts))}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
