// Extracted from ./FactoryFinancialSnapshot.tsx
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Wallet, Truck, UserRound, ChevronDown, ChevronUp, ExternalLink, Plus, X } from "lucide-react";
import { usd } from "./factoryfinancialsnapshot/utils";
import { KpiCard } from "./factoryfinancialsnapshot/components/KpiCard";
import { SectionHeader } from "./factoryfinancialsnapshot/components/SectionHeader";
import type { FactoryFinancialSnapshotPageModel } from "./FactoryFinancialSnapshotPageModel";

export function FactoryFinancialSnapshotAccounts({ m }: { m: FactoryFinancialSnapshotPageModel }) {
  // Local aliases keep TypeScript's narrowing of computed through allLoading.
  const { computed } = m;
  const allLoading = m.isLoading || !computed;
  return (
    <div>
      <SectionHeader title="Accounts & Finance" color="var(--factory-color-500)" />
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
                  onClick={() => m.setCashBankExpanded((v) => !v)}
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
                    {m.cashBankExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </button>
                {m.canChangeExistingRecords && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 mt-0.5"
                    onClick={() => {
                      m.setPickerFor("cashbank");
                      m.setPickerSearch("");
                    }}
                    data-testid="button-add-cashbank-account"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {m.cashBankExpanded && computed.cashBankList.length > 0 && (
                <div className="mt-3 pt-3 border-t space-y-1">
                  {computed.cashBankList.map((acct, i) => (
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
                        data-testid={`button-cashbank-account-${acct.id}`}
                      >
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity" />
                        <span className="text-sm text-foreground truncate">{acct.name}</span>
                        {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                        >
                          {usd(acct.signedBalance)}
                        </span>
                        {m.canChangeExistingRecords && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
                            onClick={() =>
                              m.removeAccountMutation.mutate({ type: "cashbank", accountId: acct.compositeId })
                            }
                            data-testid={`button-remove-cashbank-${acct.id}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {m.cashBankExpanded && computed.cashBankList.length === 0 && (
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
                  onClick={() => m.setAgentExpanded((v) => !v)}
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
                    {m.agentExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </button>
                {m.canChangeExistingRecords && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 mt-0.5"
                    onClick={() => {
                      m.setPickerFor("agent");
                      m.setPickerSearch("");
                    }}
                    data-testid="button-add-agent-account"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {m.agentExpanded && computed.agentList.length > 0 && (
                <div className="mt-3 pt-3 border-t space-y-1">
                  {computed.agentList.map((acct, i) => (
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
                        data-testid={`button-agent-account-${acct.id}`}
                      >
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity" />
                        <span className="text-sm text-foreground truncate">{acct.name}</span>
                        {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                        >
                          {usd(acct.signedBalance)}
                        </span>
                        {m.canChangeExistingRecords && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
                            onClick={() =>
                              m.removeAccountMutation.mutate({ type: "agent", accountId: acct.compositeId })
                            }
                            data-testid={`button-remove-agent-${acct.id}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {m.agentExpanded && computed.agentList.length === 0 && (
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
                  onClick={() => m.setFreightExpanded((v) => !v)}
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
                    {m.freightExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </button>
                {m.canChangeExistingRecords && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 mt-0.5"
                    onClick={() => {
                      m.setPickerFor("freight");
                      m.setPickerSearch("");
                    }}
                    data-testid="button-add-freight-account"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {m.freightExpanded && computed.freightList.length > 0 && (
                <div className="mt-3 pt-3 border-t space-y-1">
                  {computed.freightList.map((acct, i) => (
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
                        data-testid={`button-freight-account-${acct.id}`}
                      >
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity" />
                        <span className="text-sm text-foreground truncate">{acct.name}</span>
                        {acct.code && <span className="text-xs text-muted-foreground shrink-0">{acct.code}</span>}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-sm font-mono font-medium ${acct.signedBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                        >
                          {usd(acct.signedBalance)}
                        </span>
                        {m.canChangeExistingRecords && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 touch:opacity-100 focus-visible:opacity-100 transition-opacity"
                            onClick={() =>
                              m.removeAccountMutation.mutate({ type: "freight", accountId: acct.compositeId })
                            }
                            data-testid={`button-remove-freight-${acct.id}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {m.freightExpanded && computed.freightList.length === 0 && (
                <p className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center">
                  Click + to add freight/embassy accounts
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
