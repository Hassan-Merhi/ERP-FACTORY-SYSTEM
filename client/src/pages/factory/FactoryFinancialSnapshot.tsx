import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Package,
  Layers,
  Scale,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  HardHat,
  BarChart3,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  X,
} from "lucide-react";
import { kg, usd } from "./factoryfinancialsnapshot/utils";
import { KpiCard } from "./factoryfinancialsnapshot/components/KpiCard";
import { SectionHeader } from "./factoryfinancialsnapshot/components/SectionHeader";
import { SearchField } from "@/components/ui/search-field";
import { useFactoryFinancialSnapshotPageModel } from "./FactoryFinancialSnapshotPageModel";
import { FactoryFinancialSnapshotAccounts } from "./FactoryFinancialSnapshotAccounts";
export default function FactoryFinancialSnapshot() {
  const m = useFactoryFinancialSnapshotPageModel();

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="sticky top-0 z-50 bg-background border-b">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-muted-foreground" />
              <PageHeader title="Financial Snapshot" />
            </div>
            <div className="flex items-center gap-2">
              {m.lastUpdated && (
                <span className="text-xs text-muted-foreground hidden sm:block">Updated {m.lastUpdated}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={m.handleRefresh}
                disabled={m.isLoading}
                data-testid="button-refresh-snapshot"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${m.isFetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* ── Section 1: Factory Floor ─────────────────────────────────── */}
          <div>
            <SectionHeader title="Factory Floor" color="#10b981" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <KpiCard
                icon={Package}
                title="Raw Material Value"
                value={m.computed ? usd(m.computed.rawMaterialValue) : "—"}
                sub="Remaining stock"
                color="green"
                loading={m.allLoading}
              />
              <KpiCard
                icon={Layers}
                title="Mix Batches on Tables"
                value={m.computed ? usd(m.computed.mixBatchValue) : "—"}
                sub="Active & open batches"
                color="blue"
                loading={m.allLoading}
              />
              <KpiCard
                icon={Scale}
                title="Bale Stock Weight"
                value={m.snapshot ? kg(m.snapshot.baleWeightTotal) : "—"}
                sub={m.snapshot ? `${m.snapshot.baleCount.toLocaleString()} bales in stock` : undefined}
                color="purple"
                loading={m.loadingSnapshot}
              />
            </div>
          </div>

          <Separator />

          {/* ── Section 2: Balances & Credit ─────────────────────────────── */}
          <div>
            <SectionHeader title="Balances & Credit" color="#f59e0b" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* ── Supplier Balances (auto: all suppliers) ── */}
              {m.allLoading ? (
                <KpiCard icon={TrendingDown} title="Supplier Balances" value="—" color="red" loading />
              ) : (
                <Card data-testid="kpi-card-supplier">
                  <CardContent className="p-4">
                    <button
                      className="w-full text-left"
                      onClick={() => m.setSupplierExpanded((v) => !v)}
                      data-testid="button-expand-supplier"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 p-2 rounded-md bg-muted shrink-0 text-red-500">
                          <TrendingDown className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Supplier Balances</p>
                          <p
                            className="text-lg font-semibold font-mono mt-0.5 text-red-600 dark:text-red-400"
                            data-testid="value-supplier"
                          >
                            {usd(m.computed.supplierNet)}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {m.computed.supplierCount} supplier{m.computed.supplierCount !== 1 ? "s" : ""} · Owed to
                            suppliers
                            {(m.netPosition?.supplierOverpayments ?? 0) > 0 && (
                              <span className="text-green-600 dark:text-green-400">
                                {" "}
                                · {usd(m.netPosition?.supplierOverpayments ?? 0)} overpaid (recoverable)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {m.supplierExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>
                    </button>
                    {m.supplierExpanded && m.computed.supplierList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {m.computed.supplierList.map((s, i) => (
                          <div key={i} className="py-1.5 px-2 rounded-md">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm text-foreground truncate">
                                {s.name}
                                {s.overpaid && (
                                  <span className="ml-1 text-xs text-green-600 dark:text-green-400">(overpaid)</span>
                                )}
                              </span>
                              <span
                                className={`text-sm font-mono font-medium shrink-0 ${s.overpaid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                              >
                                {usd(Math.abs(s.value))}
                              </span>
                            </div>
                            {s.breakdown && s.breakdown.length > 0 && (
                              <div className="mt-1 pl-2 space-y-0.5">
                                {s.breakdown.map((b, bi) => (
                                  <div key={bi} className="flex items-center justify-between gap-2">
                                    <span className="text-xs text-muted-foreground truncate">{b.label}</span>
                                    <span className="text-xs text-muted-foreground shrink-0">
                                      {b.native} ≈ {usd(b.usd)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {m.supplierExpanded && m.computed.supplierList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        No supplier balances found
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Customer Credit (auto: all Dr customers) ── */}
              {m.allLoading ? (
                <KpiCard icon={TrendingUp} title="Customer Credit" value="—" color="green" loading />
              ) : (
                <Card data-testid="kpi-card-customer">
                  <CardContent className="p-4">
                    <button
                      className="w-full text-left"
                      onClick={() => m.setCustomerExpanded((v) => !v)}
                      data-testid="button-expand-customer"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 p-2 rounded-md bg-muted shrink-0 text-emerald-500">
                          <TrendingUp className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Customer Credit</p>
                          <p
                            className="text-lg font-semibold font-mono mt-0.5 text-emerald-600 dark:text-emerald-400"
                            data-testid="value-customer"
                          >
                            {usd(m.computed.customerNet)}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {m.computed.customerCount === 0
                              ? "No customer balances"
                              : `${m.computed.customerCount} customer${m.computed.customerCount !== 1 ? "s" : ""} · Total owed by customers`}
                          </p>
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {m.customerExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>
                    </button>
                    {m.customerExpanded && m.computed.customerList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {m.computed.customerList.map((c, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md">
                            <span className="text-sm text-foreground truncate">{c.name}</span>
                            <span className="text-sm font-mono font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                              {usd(c.value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.customerExpanded && m.computed.customerList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        No customer balances found
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Worker Advances Outstanding (pinned) ── */}
              {m.allLoading ? (
                <KpiCard icon={HardHat} title="Worker Advances Outstanding" value="—" color="amber" loading />
              ) : (
                <Card data-testid="kpi-card-advance">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        className="flex-1 flex items-start gap-3 text-left min-w-0"
                        onClick={() => m.setAdvanceExpanded((v) => !v)}
                        data-testid="button-expand-advance"
                      >
                        <div className="mt-0.5 p-2 rounded-md bg-muted shrink-0 text-amber-500">
                          <HardHat className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Worker Advances Outstanding</p>
                          <p
                            className="text-lg font-semibold font-mono mt-0.5 text-amber-600 dark:text-amber-400"
                            data-testid="value-advance"
                          >
                            {m.computed.advanceCount === 0 ? (
                              <span className="text-sm font-normal text-muted-foreground">No accounts selected</span>
                            ) : (
                              usd(Math.abs(m.computed.advanceNet))
                            )}
                          </p>
                          {m.computed.advanceCount > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {m.computed.advanceCount} account{m.computed.advanceCount !== 1 ? "s" : ""} · Outstanding
                              advances
                            </p>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {m.advanceExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </button>
                      {m.canChangeExistingRecords && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="shrink-0 mt-0.5"
                          onClick={() => {
                            m.setPickerFor("advance");
                            m.setPickerSearch("");
                          }}
                          data-testid="button-add-advance-account"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {m.advanceExpanded && m.computed.advanceList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {m.computed.advanceList.map((acct, i) => (
                          <div
                            key={acct.id ?? i}
                            className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md group"
                          >
                            <button
                              className="flex items-center gap-1.5 min-w-0 text-left hover-elevate rounded-sm flex-1 py-0.5 px-1"
                              onClick={() =>
                                m.navigate(
                                  `/factory/accounts?accountId=${acct.id}&accountType=ledger${m.netPosition?.asOf ? `&endDate=${m.netPosition.asOf}` : ""}`
                                )
                              }
                              data-testid={`button-advance-account-${acct.id}`}
                            >
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity" />
                              <span className="text-sm text-foreground truncate">{acct.name}</span>
                              {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-sm font-mono font-medium text-amber-600 dark:text-amber-400">
                                {usd(acct.signedBalance)}
                              </span>
                              {m.canChangeExistingRecords && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
                                  onClick={() =>
                                    m.removeAccountMutation.mutate({ type: "advance", accountId: acct.compositeId })
                                  }
                                  data-testid={`button-remove-advance-${acct.id}`}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.advanceExpanded && m.computed.advanceList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        Click + to add advance accounts
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          <Separator />

          {/* ── Section 3: Accounts & Finance ────────────────────────────── */}
          <FactoryFinancialSnapshotAccounts m={m} />

          {/* ── Disclaimer ───────────────────────────────────────────────── */}
          <div className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Values are sourced from the Net Position. Raw material value uses the Factory Raw Material Stock figure.
              Mix batches on table uses the Balance on Table figure. Supplier balances is the sum of all suppliers in
              USD including brokers. Customer credit is the sum of all customer balances. Cash &amp; Bank and Freight /
              Embassy / Shipping accounts are manually configured using the + button.
            </span>
          </div>
        </div>
      </div>

      {/* ── Account Picker Dialog ─────────────────────────────────────── */}
      <Dialog
        open={m.pickerFor !== null}
        onOpenChange={(open) => {
          if (!open) m.setPickerFor(null);
        }}
      >
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col gap-0 p-0">
          <DialogHeader className="p-4 pb-3 border-b shrink-0">
            <DialogTitle>Add {m.cardLabel} Account</DialogTitle>
          </DialogHeader>
          <div className="p-3 border-b shrink-0">
            <SearchField
              className="h-8 text-sm"
              placeholder="Search accounts..."
              value={m.pickerSearch}
              onValueChange={m.setPickerSearch}
              autoFocus
              data-testid="input-picker-search"
            />
          </div>
          <div className="overflow-y-auto flex-1 p-2">
            {m.pickerAccounts.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                {m.pickerSearch ? "No accounts match your search" : "All accounts already selected"}
              </p>
            )}
            {m.pickerAccounts.map((acct, i) => {
              const acctId = acct.id;
              const compositeId = `ledger-${acctId}`;
              const side = acct.side;
              const signedBal = side === "forUs" ? acct.value : -acct.value;
              return (
                <button
                  key={acctId ?? i}
                  className="w-full flex items-center justify-between gap-3 py-2 px-3 rounded-md hover-elevate text-left"
                  onClick={() => {
                    if (!m.pickerFor) return;
                    m.addAccountMutation.mutate({
                      type: m.pickerFor,
                      body: { accountId: compositeId, accountType: "ledger", accountName: acct.name },
                    });
                    m.setPickerFor(null);
                  }}
                  data-testid={`button-picker-account-${acctId}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{acct.name}</p>
                    {acct.code && (
                      <p className="text-xs text-muted-foreground">
                        {acct.code} · {acct.category}
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-sm font-mono shrink-0 ${signedBal >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    {usd(signedBal)}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
