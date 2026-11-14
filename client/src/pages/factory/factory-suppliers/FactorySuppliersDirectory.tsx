import { useState, type ReactNode } from "react";
import {
  ArrowRightLeft,
  Calendar,
  Boxes,
  Search,
  UsersRound,
  Wallet,
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
import { PageState } from "@/components/ui/page-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  // Search only narrows displayed rows; balances remain based on all suppliers.
  const [supplierSearch, setSupplierSearch] = useState("");
  const searchQuery = supplierSearch.trim().toLocaleLowerCase();
  const visibleSuppliers = model.filteredTopLevel.filter((supplier) =>
    supplier.name.toLocaleLowerCase().includes(searchQuery)
  );
  return (
    <div
      data-testid="factory-suppliers-directory"
      className="relative isolate space-y-5 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-slate-50 via-white to-blue-50/50 p-4 shadow-sm sm:p-6 dark:border-[hsl(var(--factory-hue)_50%_22%)] dark:from-[hsl(var(--factory-hue)_73%_10%)] dark:via-[hsl(var(--factory-hue)_64%_10%)] dark:to-[hsl(var(--factory-hue)_70%_8%)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.22)]"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Parties hub "Suppliers" tab: the hub PageHeader titles the page, so no second page title here. */}
        <p className="text-sm text-slate-500 dark:text-slate-300">
          {model.brokerCount} brokers · {model.standaloneCount} standalone
        </p>
        <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <Input
              value={supplierSearch}
              onChange={(event) => setSupplierSearch(event.target.value)}
              placeholder="Search suppliers..."
              aria-label="Search suppliers"
              data-testid="input-search-suppliers"
              className="h-10 w-full rounded-xl border-slate-200 bg-white pl-10 text-slate-900 placeholder:text-slate-400 dark:border-[hsl(var(--factory-hue)_35%_33%)] dark:bg-[hsl(var(--factory-hue)_63%_14%)] dark:text-white dark:placeholder:text-slate-400"
            />
          </div>
          {model.canCreateSupplier && (
            <Button
              className="h-10 shrink-0 rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 px-4 font-semibold text-white shadow-md shadow-blue-600/15 hover:from-blue-500 hover:to-blue-600"
              onClick={() => {
                model.resetForm();
                model.setCreateOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Supplier
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Brokers" value={model.brokerCount} icon={<UsersRound className="h-5 w-5" />} tone="blue" />
        <Metric
          label="Standalone Suppliers"
          value={model.standaloneCount}
          icon={<Boxes className="h-5 w-5" />}
          tone="emerald"
        />
        <Metric
          label="Total Containers"
          value={model.totalContainers}
          icon={<Package className="h-5 w-5" />}
          tone="violet"
        />
        <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-4 shadow-sm dark:border-amber-500/35 dark:from-[#382c1c] dark:to-[#211d1b]">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              <Wallet className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-200">
                Supplier balances (USD equivalent)
              </p>
              <div className="mt-1 text-sm">
                <span className="text-slate-600 dark:text-slate-300">You owe </span>
                <span
                  className="font-bold tabular-nums text-red-600 dark:text-red-400"
                  data-testid="text-total-usd-owed"
                >
                  {"-$" + model.formatNum(model.totalUsdOwed.toFixed(2))}
                </span>
              </div>
              <div className="text-sm">
                <span className="text-slate-600 dark:text-slate-300">Owed to you </span>
                <span
                  className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                  data-testid="text-total-usd-overpaid"
                >
                  {"$" + model.formatNum(model.totalUsdOverpaid.toFixed(2))}
                </span>
              </div>
              {model.unpricedSupplierCount > 0 && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300" role="alert">
                  {model.unpricedSupplierCount} supplier(s) excluded: missing FX rates or broker statement
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={model.activeFilter} onValueChange={(value) => model.setActiveFilter(value as SupplierFilter)}>
          <SelectTrigger
            className="h-10 w-44 rounded-xl border-slate-200 bg-white dark:border-[hsl(var(--factory-hue)_35%_33%)] dark:bg-[hsl(var(--factory-hue)_63%_14%)]"
            data-testid="select-supplier-filter"
          >
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
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-[hsl(var(--factory-hue)_35%_33%)] dark:bg-[hsl(var(--factory-hue)_63%_14%)]">
          <Switch
            checked={model.listIncludeOtw}
            onCheckedChange={model.setListIncludeOtw}
            id="list-otw-toggle"
            data-testid="switch-include-otw"
          />
          <label htmlFor="list-otw-toggle" className="cursor-pointer select-none text-sm font-medium">
            Include OTW
          </label>
        </div>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
          Showing {visibleSuppliers.length} of {model.filteredTopLevel.length} suppliers
        </span>
      </div>

      <div className="space-y-3" aria-label="Supplier directory">
        {visibleSuppliers.map((supplier) => {
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
            <div
              key={supplier.id}
              className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/50 lg:flex-row lg:items-center lg:gap-4 dark:border-[hsl(var(--factory-hue)_41%_26%)] dark:bg-[hsl(var(--factory-hue)_52%_13%)]/90 dark:hover:border-blue-500/50 dark:hover:bg-[hsl(var(--factory-hue)_56%_18%)]"
            >
              <div
                className={
                  isBroker
                    ? "absolute inset-y-3 left-0 w-1 rounded-r-full bg-emerald-500"
                    : "absolute inset-y-3 left-0 w-1 rounded-r-full bg-blue-500"
                }
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-1 items-center gap-3 pl-1.5">
                <div
                  className={
                    isBroker
                      ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-sm font-bold text-white shadow-sm"
                      : "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-sm font-bold text-white shadow-sm"
                  }
                  aria-hidden="true"
                >
                  {supplier.name
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part.charAt(0))
                    .join("")
                    .toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-900 dark:text-white">
                    <span className="break-words">{supplier.name}</span>
                    {isBroker && (
                      <Badge
                        variant="secondary"
                        className="border border-slate-200 bg-slate-100 text-slate-700 dark:border-[hsl(var(--factory-hue)_30%_39%)] dark:bg-[hsl(var(--factory-hue)_38%_25%)] dark:text-slate-100"
                      >
                        Broker
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 sm:text-sm dark:text-slate-300">
                    <span className="flex items-center gap-1">
                      <Package className="h-3.5 w-3.5" aria-hidden="true" />
                      {supplier.totalContainers} containers
                    </span>
                    {otwCount > 0 && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/70 bg-amber-50 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                      >
                        {otwCount} OTW
                      </Badge>
                    )}
                    {kgNumber > 0 && (
                      <span className="flex items-center gap-1">
                        <Weight className="h-3.5 w-3.5" aria-hidden="true" />
                        {model.formatKg(supplier.totalKg)}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                      Last: {supplier.lastContainerDate ? model.formatDate(supplier.lastContainerDate) : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div
                className="min-w-0 space-y-1 text-left lg:max-w-[300px] lg:flex-[0_1_280px] lg:text-right"
                data-testid={`supplier-directory-balance-${supplier.id}`}
              >
                <div className="text-xs text-slate-500 dark:text-slate-300">
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
                    className={`text-base font-bold tabular-nums ${
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
              <div className="flex shrink-0 items-center gap-1 self-start lg:self-auto">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg border-blue-200 bg-blue-50 font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-600/60 dark:bg-blue-600/20 dark:text-blue-100 dark:hover:bg-blue-600/30"
                  onClick={openSupplier}
                  data-testid={`btn-view-supplier-${supplier.id}`}
                >
                  <Eye className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  View
                </Button>
                {(model.canChangeExistingRecords || model.canCreateSupplier || model.canRecordFxTransfer) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-lg"
                        data-testid={`btn-menu-supplier-${supplier.id}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {model.canChangeExistingRecords && (
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
                      )}
                      {model.canChangeExistingRecords && !isBroker && !supplier.parentId && (
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
                      {model.canCreateSupplier && isBroker && (
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
                      {model.canRecordFxTransfer &&
                        nonUsdBalances
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
                      {model.canChangeExistingRecords && isBroker && (
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
                      {model.canChangeExistingRecords && (
                        <>
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
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  aria-label={`Open ${supplier.name}`}
                  onClick={openSupplier}
                >
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </Button>
              </div>
            </div>
          );
        })}
        {visibleSuppliers.length === 0 && !model.isLoading && (
          <PageState title="No suppliers found" icon={Package} className="border-0" />
        )}
      </div>

      <FactorySuppliersDialogBundle model={model} includeDeleteConfirm />
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: "blue" | "emerald" | "violet";
}) {
  const styles = {
    blue: "border-blue-200 from-blue-50 to-white dark:border-blue-500/50 dark:from-[hsl(var(--factory-hue)_70%_21%)] dark:to-[hsl(var(--factory-hue)_75%_14%)]",
    emerald:
      "border-emerald-200 from-emerald-50 to-white dark:border-emerald-500/50 dark:from-[#0b3939] dark:to-[hsl(var(--factory-hue)_61%_11%)]",
    violet:
      "border-violet-200 from-violet-50 to-white dark:border-violet-500/50 dark:from-[hsl(var(--factory-hue)_43%_22%)] dark:to-[hsl(var(--factory-hue)_43%_18%)]",
  };
  const iconStyles = {
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  };
  return (
    <div
      className={"flex min-h-28 items-center gap-3 rounded-2xl border bg-gradient-to-br p-4 shadow-sm " + styles[tone]}
    >
      <div
        className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-xl " + iconStyles[tone]}
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-200">{label}</div>
        <div className="mt-1 text-2xl font-bold leading-none tabular-nums text-slate-900 dark:text-white">{value}</div>
      </div>
    </div>
  );
}
