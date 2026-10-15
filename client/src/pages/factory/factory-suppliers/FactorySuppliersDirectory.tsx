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
import { PageState } from "@/components/ui/page-state";
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
          <div className="text-xs text-muted-foreground">Supplier balances (USD equivalent)</div>
          <div className="text-sm font-semibold mt-1">
            <span className="text-muted-foreground">You owe </span>
            <span className="text-red-600 dark:text-red-400" data-testid="text-total-usd-owed">
              -${model.formatNum(model.totalUsdOwed.toFixed(2))}
            </span>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Owed to you </span>
            <span className="text-green-600 dark:text-green-400" data-testid="text-total-usd-overpaid">
              ${model.formatNum(model.totalUsdOverpaid.toFixed(2))}
            </span>
          </div>
          {model.unpricedSupplierCount > 0 && (
            <p className="text-[11px] text-amber-600" role="alert">
              {model.unpricedSupplierCount} supplier(s) excluded: missing FX rates or broker statement
            </p>
          )}
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
          // One rule for every supplier and broker: the inside statement's
          // signed pools as USD + Σ(native × Factory Settings rate).
          // Positive = we owe them (shown red, negative); negative = they owe us (green).
          const usdEquivalent = supplier.usdEquivalentBalance == null ? null : Number(supplier.usdEquivalentBalance);
          const missingRates = supplier.usdEquivalentMissingRates || [];
          const isBroker = !!model.subAccountsByParent[supplier.id]?.length || !!supplier.isBroker;
          const otwCount = supplier.otwByCurrency
            ? Object.values(supplier.otwByCurrency).reduce((left, right) => left + right, 0)
            : supplier.pendingContainers || 0;
          const kgNumber = parseFloat(supplier.totalKg || "0");
          const nonUsdBalances = (
            supplier.settlementBalances?.map((pool) => ({
              currencyCode: pool.currencyCode,
              balance: Number(pool.balance),
            })) ||
            supplier.currencyBalances ||
            []
          ).filter((balance) => balance.currencyCode !== "USD" && Math.abs(balance.balance) > 0.005);
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
                    <Badge variant="outline" className="text-amber-600 border-amber-400 text-[11px]">
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

              <div className="text-right shrink-0 space-y-1" data-testid={`supplier-directory-balance-${supplier.id}`}>
                <div className="text-xs text-muted-foreground">
                  {usdEquivalent === null || Math.abs(usdEquivalent) <= 0.005
                    ? "Balance (USD equivalent)"
                    : usdEquivalent > 0
                      ? "You owe this supplier (USD equivalent)"
                      : "This supplier owes you (USD equivalent)"}
                </div>
                {usdEquivalent === null ? (
                  <div className="text-xs text-amber-600" role="alert">
                    Set FX rate for {missingRates.join(", ") || "the outstanding currency"} in Factory Settings
                  </div>
                ) : (
                  <div
                    className={`font-semibold text-sm tabular-nums ${
                      usdEquivalent > 0.005
                        ? "text-red-600 dark:text-red-400"
                        : usdEquivalent < -0.005
                          ? "text-green-600 dark:text-green-400"
                          : "text-muted-foreground"
                    }`}
                    data-testid={`text-directory-usd-equivalent-${supplier.id}`}
                  >
                    {Math.abs(usdEquivalent) <= 0.005
                      ? "$0.00"
                      : `${usdEquivalent > 0 ? "-" : ""}$${model.formatNum(Math.abs(usdEquivalent).toFixed(2))}`}
                  </div>
                )}
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
          <PageState title="No suppliers found" icon={Package} className="border-0" />
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
