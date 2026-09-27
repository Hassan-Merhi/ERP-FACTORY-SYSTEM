import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Package,
  Layers,
  Scale,
  TrendingUp,
  TrendingDown,
  Wallet,
  Truck,
  UserRound,
  RefreshCw,
  HardHat,
  BarChart3,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  X,
  Search,
} from "lucide-react";
import { kg, usd } from "./factoryfinancialsnapshot/utils";
import { KpiCard } from "./factoryfinancialsnapshot/components/KpiCard";
import { SectionHeader } from "./factoryfinancialsnapshot/components/SectionHeader";
import { useFactoryFinancialSnapshotModel } from "./factoryfinancialsnapshot/useFactoryFinancialSnapshotModel";
export default function FactoryFinancialSnapshot() {
  const [, navigate] = useLocation();
  const financialSnapshot = useFactoryFinancialSnapshotModel();
  const {
    addAccountMutation,
    advanceExpanded,
    agentExpanded,
    cardLabel,
    cashBankExpanded,
    computed,
    customerExpanded,
    freightExpanded,
    handleRefresh,
    isFetching,
    isLoading,
    lastUpdated,
    loadingSnapshot,
    netPosition,
    pickerAccounts,
    pickerFor,
    pickerSearch,
    removeAccountMutation,
    setAdvanceExpanded,
    setAgentExpanded,
    setCashBankExpanded,
    setCustomerExpanded,
    setFreightExpanded,
    setPickerFor,
    setPickerSearch,
    setSupplierExpanded,
    snapshot,
    supplierExpanded,
  } = financialSnapshot;
  const allLoading = isLoading || !computed;

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
              {lastUpdated && (
                <span className="text-xs text-muted-foreground hidden sm:block">Updated {lastUpdated}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefresh}
                disabled={isLoading}
                data-testid="button-refresh-snapshot"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
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
                value={computed ? usd(computed.rawMaterialValue) : "—"}
                sub="Remaining stock"
                color="green"
                loading={allLoading}
              />
              <KpiCard
                icon={Layers}
                title="Mix Batches on Tables"
                value={computed ? usd(computed.mixBatchValue) : "—"}
                sub="Active & open batches"
                color="blue"
                loading={allLoading}
              />
              <KpiCard
                icon={Scale}
                title="Bale Stock Weight"
                value={snapshot ? kg(snapshot.baleWeightTotal) : "—"}
                sub={snapshot ? `${snapshot.baleCount.toLocaleString()} bales in stock` : undefined}
                color="purple"
                loading={loadingSnapshot}
              />
            </div>
          </div>

          <Separator />

          {/* ── Section 2: Balances & Credit ─────────────────────────────── */}
          <div>
            <SectionHeader title="Balances & Credit" color="#f59e0b" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* ── Supplier Balances (auto: all suppliers) ── */}
              {allLoading ? (
                <KpiCard icon={TrendingDown} title="Supplier Balances" value="—" color="red" loading />
              ) : (
                <Card data-testid="kpi-card-supplier">
                  <CardContent className="p-4">
                    <button
                      className="w-full text-left"
                      onClick={() => setSupplierExpanded((v) => !v)}
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
                            {usd(computed.supplierNet)}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {computed.supplierCount} supplier{computed.supplierCount !== 1 ? "s" : ""} · Owed to
                            suppliers
                            {(netPosition?.supplierOverpayments ?? 0) > 0 && (
                              <span className="text-green-600 dark:text-green-400">
                                {" "}
                                · {usd(netPosition?.supplierOverpayments ?? 0)} overpaid (recoverable)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {supplierExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>
                    </button>
                    {supplierExpanded && computed.supplierList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.supplierList.map((s, i) => (
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
                    {supplierExpanded && computed.supplierList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        No supplier balances found
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Customer Credit (auto: all Dr customers) ── */}
              {allLoading ? (
                <KpiCard icon={TrendingUp} title="Customer Credit" value="—" color="green" loading />
              ) : (
                <Card data-testid="kpi-card-customer">
                  <CardContent className="p-4">
                    <button
                      className="w-full text-left"
                      onClick={() => setCustomerExpanded((v) => !v)}
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
                            {usd(computed.customerNet)}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {computed.customerCount === 0
                              ? "No customer balances"
                              : `${computed.customerCount} customer${computed.customerCount !== 1 ? "s" : ""} · Total owed by customers`}
                          </p>
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {customerExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>
                    </button>
                    {customerExpanded && computed.customerList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.customerList.map((c, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md">
                            <span className="text-sm text-foreground truncate">{c.name}</span>
                            <span className="text-sm font-mono font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                              {usd(c.value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {customerExpanded && computed.customerList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        No customer balances found
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Worker Advances Outstanding (pinned) ── */}
              {allLoading ? (
                <KpiCard icon={HardHat} title="Worker Advances Outstanding" value="—" color="amber" loading />
              ) : (
                <Card data-testid="kpi-card-advance">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        className="flex-1 flex items-start gap-3 text-left min-w-0"
                        onClick={() => setAdvanceExpanded((v) => !v)}
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
                            {computed.advanceCount === 0 ? (
                              <span className="text-sm font-normal text-muted-foreground">No accounts selected</span>
                            ) : (
                              usd(Math.abs(computed.advanceNet))
                            )}
                          </p>
                          {computed.advanceCount > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {computed.advanceCount} account{computed.advanceCount !== 1 ? "s" : ""} · Outstanding
                              advances
                            </p>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {advanceExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 mt-0.5"
                        onClick={() => {
                          setPickerFor("advance");
                          setPickerSearch("");
                        }}
                        data-testid="button-add-advance-account"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {advanceExpanded && computed.advanceList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.advanceList.map((acct, i) => (
                          <div
                            key={acct.id ?? i}
                            className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md group"
                          >
                            <button
                              className="flex items-center gap-1.5 min-w-0 text-left hover-elevate rounded flex-1 py-0.5 px-1"
                              onClick={() =>
                                navigate(
                                  `/factory/accounts?accountId=${acct.id}&accountType=ledger${netPosition?.asOf ? `&endDate=${netPosition.asOf}` : ""}`
                                )
                              }
                              data-testid={`button-advance-account-${acct.id}`}
                            >
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              <span className="text-sm text-foreground truncate">{acct.name}</span>
                              {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-sm font-mono font-medium text-amber-600 dark:text-amber-400">
                                {usd(acct.signedBalance)}
                              </span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                onClick={() =>
                                  removeAccountMutation.mutate({ type: "advance", accountId: acct.compositeId })
                                }
                                data-testid={`button-remove-advance-${acct.id}`}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {advanceExpanded && computed.advanceList.length === 0 && (
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
          <div>
            <SectionHeader title="Accounts & Finance" color="#6366f1" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* ── Cash & Bank (manual pinned) ── */}
              {allLoading ? (
                <KpiCard icon={Wallet} title="Cash & Bank" value="—" color="green" loading />
              ) : (
                <Card data-testid="kpi-card-cash-bank">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        className="flex-1 flex items-start gap-3 text-left min-w-0"
                        onClick={() => setCashBankExpanded((v) => !v)}
                        data-testid="button-expand-cash-bank"
                      >
                        <div
                          className={`mt-0.5 p-2 rounded-md bg-muted shrink-0 ${computed.cashBankTotal >= 0 ? "text-emerald-500" : "text-red-500"}`}
                        >
                          <Wallet className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Cash & Bank</p>
                          <p
                            className={`text-lg font-semibold font-mono mt-0.5 ${computed.cashBankTotal >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                            data-testid="value-cash-bank"
                          >
                            {computed.cashBankCount === 0 ? (
                              <span className="text-sm font-normal text-muted-foreground">No accounts selected</span>
                            ) : (
                              usd(computed.cashBankTotal)
                            )}
                          </p>
                          {computed.cashBankCount > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {computed.cashBankCount} account{computed.cashBankCount !== 1 ? "s" : ""}
                            </p>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {cashBankExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 mt-0.5"
                        onClick={() => {
                          setPickerFor("cashbank");
                          setPickerSearch("");
                        }}
                        data-testid="button-add-cashbank-account"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {cashBankExpanded && computed.cashBankList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.cashBankList.map((acct, i) => (
                          <div
                            key={acct.id ?? i}
                            className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md group"
                          >
                            <button
                              className="flex items-center gap-1.5 min-w-0 text-left hover-elevate rounded flex-1 py-0.5 px-1"
                              onClick={() =>
                                navigate(
                                  `/factory/accounts?accountId=${acct.id}&accountType=ledger${netPosition?.asOf ? `&endDate=${netPosition.asOf}` : ""}`
                                )
                              }
                              data-testid={`button-cashbank-account-${acct.id}`}
                            >
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              <span className="text-sm text-foreground truncate">{acct.name}</span>
                              {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span
                                className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                              >
                                {usd(acct.signedBalance)}
                              </span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                onClick={() =>
                                  removeAccountMutation.mutate({ type: "cashbank", accountId: acct.compositeId })
                                }
                                data-testid={`button-remove-cashbank-${acct.id}`}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {cashBankExpanded && computed.cashBankList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        Click + to add cash & bank accounts
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Agent Accounts (manual) ── */}
              {allLoading ? (
                <KpiCard icon={UserRound} title="Agent Accounts" value="—" color="amber" loading />
              ) : (
                <Card data-testid="kpi-card-agents">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        className="flex-1 flex items-start gap-3 text-left min-w-0"
                        onClick={() => setAgentExpanded((v) => !v)}
                        data-testid="button-expand-agents"
                      >
                        <div
                          className={`mt-0.5 p-2 rounded-md bg-muted shrink-0 ${computed.agentNet >= 0 ? "text-emerald-500" : "text-amber-500"}`}
                        >
                          <UserRound className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Agent Accounts</p>
                          <p
                            className={`text-lg font-semibold font-mono mt-0.5 ${computed.agentNet >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                          >
                            {computed.agentCount === 0 ? (
                              <span className="text-sm font-normal text-muted-foreground">No accounts selected</span>
                            ) : (
                              usd(Math.abs(computed.agentNet))
                            )}
                          </p>
                          {computed.agentCount > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {computed.agentCount} account{computed.agentCount !== 1 ? "s" : ""} ·{" "}
                              {computed.agentNet >= 0 ? "Net receivable" : "Net payable"}
                            </p>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {agentExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 mt-0.5"
                        onClick={() => {
                          setPickerFor("agent");
                          setPickerSearch("");
                        }}
                        data-testid="button-add-agent-account"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {agentExpanded && computed.agentList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.agentList.map((acct, i) => (
                          <div
                            key={acct.id ?? i}
                            className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md group"
                          >
                            <button
                              className="flex items-center gap-1.5 min-w-0 text-left hover-elevate rounded flex-1 py-0.5 px-1"
                              onClick={() =>
                                navigate(
                                  `/factory/accounts?accountId=${acct.id}&accountType=ledger${netPosition?.asOf ? `&endDate=${netPosition.asOf}` : ""}`
                                )
                              }
                              data-testid={`button-agent-account-${acct.id}`}
                            >
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              <span className="text-sm text-foreground truncate">{acct.name}</span>
                              {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span
                                className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                              >
                                {usd(acct.signedBalance)}
                              </span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                onClick={() =>
                                  removeAccountMutation.mutate({ type: "agent", accountId: acct.compositeId })
                                }
                                data-testid={`button-remove-agent-${acct.id}`}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {agentExpanded && computed.agentList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        Click + to add agent accounts
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Freight / Embassy / Shipping (manual) ── */}
              {allLoading ? (
                <KpiCard icon={Truck} title="Freight / Embassy / Shipping" value="—" color="amber" loading />
              ) : (
                <Card data-testid="kpi-card-freight">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        className="flex-1 flex items-start gap-3 text-left min-w-0"
                        onClick={() => setFreightExpanded((v) => !v)}
                        data-testid="button-expand-freight"
                      >
                        <div
                          className={`mt-0.5 p-2 rounded-md bg-muted shrink-0 ${computed.freightNet >= 0 ? "text-emerald-500" : "text-amber-500"}`}
                        >
                          <Truck className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground font-medium">Freight / Embassy / Shipping</p>
                          <p
                            className={`text-lg font-semibold font-mono mt-0.5 ${computed.freightNet >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                          >
                            {computed.freightCount === 0 ? (
                              <span className="text-sm font-normal text-muted-foreground">No accounts selected</span>
                            ) : (
                              usd(Math.abs(computed.freightNet))
                            )}
                          </p>
                          {computed.freightCount > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {computed.freightCount} account{computed.freightCount !== 1 ? "s" : ""} ·{" "}
                              {computed.freightNet >= 0 ? "Net asset" : "Net payable"}
                            </p>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground shrink-0">
                          {freightExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 mt-0.5"
                        onClick={() => {
                          setPickerFor("freight");
                          setPickerSearch("");
                        }}
                        data-testid="button-add-freight-account"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {freightExpanded && computed.freightList.length > 0 && (
                      <div className="mt-3 pt-3 border-t space-y-1">
                        {computed.freightList.map((acct, i) => (
                          <div
                            key={acct.id ?? i}
                            className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md group"
                          >
                            <button
                              className="flex items-center gap-1.5 min-w-0 text-left hover-elevate rounded flex-1 py-0.5 px-1"
                              onClick={() =>
                                navigate(
                                  `/factory/accounts?accountId=${acct.id}&accountType=ledger${netPosition?.asOf ? `&endDate=${netPosition.asOf}` : ""}`
                                )
                              }
                              data-testid={`button-freight-account-${acct.id}`}
                            >
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              <span className="text-sm text-foreground truncate">{acct.name}</span>
                              {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span
                                className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                              >
                                {usd(acct.signedBalance)}
                              </span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                onClick={() =>
                                  removeAccountMutation.mutate({ type: "freight", accountId: acct.compositeId })
                                }
                                data-testid={`button-remove-freight-${acct.id}`}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {freightExpanded && computed.freightList.length === 0 && (
                      <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                        Click + to add freight/embassy accounts
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

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
        open={pickerFor !== null}
        onOpenChange={(open) => {
          if (!open) setPickerFor(null);
        }}
      >
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col gap-0 p-0">
          <DialogHeader className="p-4 pb-3 border-b shrink-0">
            <DialogTitle>Add {cardLabel} Account</DialogTitle>
          </DialogHeader>
          <div className="p-3 border-b shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="pl-8 h-8 text-sm"
                placeholder="Search accounts..."
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                autoFocus
                data-testid="input-picker-search"
              />
            </div>
          </div>
          <div className="overflow-y-auto flex-1 p-2">
            {pickerAccounts.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                {pickerSearch ? "No accounts match your search" : "All accounts already selected"}
              </p>
            )}
            {pickerAccounts.map((acct, i) => {
              const acctId = acct.id;
              const compositeId = `ledger-${acctId}`;
              const side = acct.side;
              const signedBal = side === "forUs" ? acct.value : -acct.value;
              return (
                <button
                  key={acctId ?? i}
                  className="w-full flex items-center justify-between gap-3 py-2 px-3 rounded-md hover-elevate text-left"
                  onClick={() => {
                    if (!pickerFor) return;
                    addAccountMutation.mutate({
                      type: pickerFor,
                      body: { accountId: compositeId, accountType: "ledger", accountName: acct.name },
                    });
                    setPickerFor(null);
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
