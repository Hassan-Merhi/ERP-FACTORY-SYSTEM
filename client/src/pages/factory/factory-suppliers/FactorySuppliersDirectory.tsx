import {
  ArrowRightLeft,
  Calendar,
  ChevronRight,
  Eye,
  EyeOff,
  GitBranch,
  Layers,
  MoreVertical,
  Package,
  Pencil,
  Plus,
  Trash2,
  Weight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FactorySuppliersDialogBundle } from "./FactorySuppliersDialogBundle";
import type { SupplierFilter, useFactorySuppliersModel } from "./useFactorySuppliersModel";

type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

export function FactorySuppliersDirectory({ model }: { model: SuppliersModel }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Brokers & Suppliers" />
          <p className="text-muted-foreground mt-1">
            {model.brokerCount} brokers · {model.standaloneCount} standalone
          </p>
        </div>
        <Button
          onClick={() => {
            model.resetForm();
            model.setCreateOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Supplier
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Brokers" value={model.brokerCount} />
        <Metric label="Standalone Suppliers" value={model.standaloneCount} />
        <Metric label="Total Containers" value={model.totalContainers} />
        <div className="rounded-xl border p-4">
          <div className="text-xs text-muted-foreground">Total USD</div>
          <div className="text-sm font-semibold mt-1">
            <span className="text-muted-foreground">We owe </span>${model.formatNum(String(model.totalUsdOwed))}
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Overpaid </span>
            <span className="text-green-600">${model.formatNum(String(model.totalUsdOverpaid))}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Select value={model.activeFilter} onValueChange={(value) => model.setActiveFilter(value as SupplierFilter)}>
          <SelectTrigger className="w-36" data-testid="select-supplier-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="brokers">Brokers</SelectItem>
            <SelectItem value="standalone">Standalone</SelectItem>
            <SelectItem value="with-balance">With Balance</SelectItem>
            <SelectItem value="zero-balance">Zero Balance</SelectItem>
            <SelectItem value="has-foreign">Has Foreign Currency</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch
            checked={model.listIncludeOtw}
            onCheckedChange={model.setListIncludeOtw}
            id="list-otw-toggle"
            data-testid="switch-include-otw"
          />
          <label htmlFor="list-otw-toggle" className="text-sm cursor-pointer select-none">
            Include OTW
          </label>
        </div>
      </div>

      <div className="rounded-xl border divide-y">
        {model.filteredTopLevel.map((supplier) => {
          // Ledger balance (wave 13); the amounts not yet in the ledger are a separate memo.
          const balanceValue = parseFloat(supplier.totalValue || "0");
          const notInLedgerValue = parseFloat(supplier.notInLedgerTotal || "0");
          const isBroker = !!model.subAccountsByParent[supplier.id]?.length || !!supplier.isBroker;
          const otwCount = supplier.otwByCurrency
            ? Object.values(supplier.otwByCurrency).reduce((left, right) => left + right, 0)
            : supplier.pendingContainers || 0;
          const kgNumber = parseFloat(supplier.totalKg || "0");
          const nonUsdBalances = (supplier.currencyBalances || []).filter(
            (balance) => balance.currencyCode !== "USD" && Math.abs(balance.balance) > 0.005
          );
          const openFx = (currencyCode: string, balance: number) => {
            const toId = supplier.parentId || supplier.id;
            const balanceString = balance.toFixed(2);
            model.setFxConversionForm({
              fromSupplierId: supplier.id,
              toSupplierId: toId,
              selectedCurrency: currencyCode,
              amount: balanceString,
              availableBalance: balanceString,
              supplierBalance: balanceString,
              commissionBalance: "0",
              fxRateToUsd: "",
              date: model.today,
              notes: "",
              effectiveDate: "",
            });
            model.setFxSourceType("supplier");
            model.setFxConversionOpen(true);
          };
          const openSupplier = () => {
            if (isBroker) model.setParentViewSupplierId(supplier.id);
            else model.setStatementSupplierId(supplier.id);
          };
          return (
            <div key={supplier.id} className="p-4 flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="font-semibold flex items-center gap-2 flex-wrap">
                  {supplier.name}
                  {isBroker && <Badge variant="secondary">Broker</Badge>}
                </div>
                <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                  <span className="flex items-center gap-1">
                    <Package className="h-3 w-3" />
                    {supplier.totalContainers} containers
                  </span>
                  {otwCount > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-400 text-[10px]">
                      {otwCount} OTW
                    </Badge>
                  )}
                  {kgNumber > 0 && (
                    <span className="flex items-center gap-1">
                      <Weight className="h-3 w-3" />
                      {model.formatKg(supplier.totalKg)}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Last: {supplier.lastContainerDate ? model.formatDate(supplier.lastContainerDate) : "—"}
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0 space-y-0.5">
                {(Math.abs(balanceValue) > 0.005 || nonUsdBalances.length > 0) && (
                  <div className="text-xs text-muted-foreground mb-0.5">Ledger balance</div>
                )}
                <div
                  className={`font-semibold text-sm ${balanceValue < 0 ? "text-green-600" : balanceValue > 0 ? "" : "text-muted-foreground"}`}
                >
                  {balanceValue === 0 && nonUsdBalances.length === 0 ? (
                    <span className="text-muted-foreground text-xs">$-</span>
                  ) : (
                    `$${model.formatNum(String(Math.abs(balanceValue)))}${balanceValue < 0 ? " CR" : ""}`
                  )}
                </div>
                {Math.abs(notInLedgerValue) > 0.005 && (
                  <div className="text-[11px] text-muted-foreground" data-testid={`text-not-in-ledger-${supplier.id}`}>
                    <span>Not yet in the ledger (memo)</span>{" "}
                    {`$${model.formatNum(String(Math.abs(notInLedgerValue).toFixed(2)))}${notInLedgerValue < 0 ? " CR" : ""}`}
                  </div>
                )}
                {nonUsdBalances.map((balance) => (
                  <div key={balance.currencyCode} className="flex items-center justify-end gap-1">
                    <span
                      className={`text-xs tabular-nums ${balance.balance < 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                    >
                      {balance.currencyCode} {model.formatNum(String(Math.abs(balance.balance).toFixed(2)))}
                      {balance.balance < 0 ? " CR" : ""}
                    </span>
                    {balance.balance > 0.005 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-muted-foreground hover:text-foreground"
                        title={`Settle ${balance.currencyCode} → USD`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openFx(balance.currencyCode, balance.balance);
                        }}
                        data-testid={`btn-fx-settle-${supplier.id}-${balance.currencyCode}`}
                      >
                        <ArrowRightLeft className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openSupplier}
                  data-testid={`btn-view-supplier-${supplier.id}`}
                >
                  View
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" data-testid={`btn-menu-supplier-${supplier.id}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        model.setEditingSupplier(supplier);
                        model.setFormData({
                          name: supplier.name,
                          contactPerson: supplier.contactPerson || "",
                          phone: supplier.phone || "",
                          email: supplier.email || "",
                          address: supplier.address || "",
                          notes: supplier.notes || "",
                          parentId: supplier.parentId,
                        });
                        model.setFormRole(supplier.parentId ? "linked" : isBroker ? "broker" : "standalone");
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    {!isBroker && !supplier.parentId && (
                      <DropdownMenuItem
                        onClick={() =>
                          model.wrapAdminAction(
                            () => model.makeBrokerMutation.mutate({ id: supplier.id, isBroker: true }),
                            "Make Broker"
                          )
                        }
                        data-testid={`btn-make-broker-${supplier.id}`}
                      >
                        <GitBranch className="h-4 w-4 mr-2" />
                        Make Broker
                      </DropdownMenuItem>
                    )}
                    {isBroker && (
                      <DropdownMenuItem
                        onClick={() => {
                          model.setCreateSubAccountParentId(supplier.id);
                          model.resetForm(supplier.id);
                          model.setCreateOpen(true);
                        }}
                        data-testid={`btn-add-linked-${supplier.id}`}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Linked Supplier
                      </DropdownMenuItem>
                    )}
                    {nonUsdBalances
                      .filter((balance) => balance.balance > 0.005)
                      .map((balance) => (
                        <DropdownMenuItem
                          key={balance.currencyCode}
                          onClick={() => openFx(balance.currencyCode, balance.balance)}
                        >
                          <ArrowRightLeft className="h-4 w-4 mr-2 text-blue-500" />
                          FX Settlement ({balance.currencyCode})
                        </DropdownMenuItem>
                      ))}
                    {isBroker && (
                      <DropdownMenuItem
                        data-testid={`btn-bulk-fx-${supplier.id}`}
                        onClick={() => {
                          model.setBulkFxBrokerId(supplier.id);
                          model.setBulkFxBrokerName(supplier.name);
                          model.setBulkFxForm({
                            fromCurrencyCode: nonUsdBalances.length > 0 ? nonUsdBalances[0].currencyCode : "EUR",
                            totalAmount: "",
                            fxRateToUsd: "",
                            date: model.today,
                            notes: "",
                            order: "oldest",
                          });
                          model.setBulkFxPreview(null);
                          model.setBulkFxOpen(true);
                        }}
                      >
                        <Layers className="h-4 w-4 mr-2 text-blue-500" />
                        Bulk FX Settlement
                      </DropdownMenuItem>
                    )}
                    {supplier.isActive ? (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() =>
                          model.wrapAdminAction(
                            () => model.deactivateMutation.mutate(supplier.id),
                            "Deactivate Supplier"
                          )
                        }
                      >
                        <EyeOff className="h-4 w-4 mr-2" />
                        Deactivate
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onClick={() =>
                          model.wrapAdminAction(
                            () => model.reactivateMutation.mutate(supplier.id),
                            "Reactivate Supplier"
                          )
                        }
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        Reactivate
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() =>
                        model.setPendingDelete(() => () => model.permanentDeleteMutation.mutate(supplier.id))
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete Permanently
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ChevronRight className="h-4 w-4 text-muted-foreground cursor-pointer" onClick={openSupplier} />
              </div>
            </div>
          );
        })}
        {model.filteredTopLevel.length === 0 && !model.isLoading && (
          <div className="p-8 text-center text-muted-foreground text-sm">No suppliers found.</div>
        )}
      </div>

      <FactorySuppliersDialogBundle model={model} includeDeleteConfirm />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
