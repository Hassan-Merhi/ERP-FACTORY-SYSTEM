import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, ChevronRight, RefreshCw, Trash2, ClipboardList, CreditCard } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";

import type { CashAccount, Props, Unit } from "./property-rental/types";
import { fmtMoney, fmtMoneyCurrency } from "./property-rental/utils";
import { ApiBaseCtx } from "./property-rental/shared";
import { NoteCell } from "./property-rental/components/NoteCell";
import { CreateUnitDialog } from "./property-rental/components/CreateUnitDialog";
import { UnitActionDialog } from "./property-rental/components/UnitActionDialog";
import { BulkPaymentDialog } from "./property-rental/components/BulkPaymentDialog";
export default function PropertyRentalPage({
  unitType,
  pageTitle,
  pageIcon,
  testIdPrefix,
  apiBase = "/api/properties/rental",
  paymentsLogUrl,
}: Props) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [openUnitId, setOpenUnitId] = useState<number | null>(null);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [confirmDeleteUnitId, setConfirmDeleteUnitId] = useState<number | null>(null);

  const { data: units = [], isLoading } = useQuery<Unit[]>({
    queryKey: [apiBase + "/units", { unitType, companyId: selectedCompany?.id }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units?unitType=${unitType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load units");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const { data: cashAccounts = [] } = useQuery<CashAccount[]>({
    queryKey: [apiBase + "/cash-accounts", selectedCompany?.id],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/cash-accounts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cash accounts");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, Unit[]>();
    units.forEach((u) => {
      if (!groups.has(u.locationGroup)) groups.set(u.locationGroup, []);
      groups.get(u.locationGroup)!.push(u);
    });
    const naturalCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    return Array.from(groups.entries())
      .sort(([a], [b]) => naturalCmp(a, b))
      .map(([grp, us]) => [grp, [...us].sort((a, b) => naturalCmp(a.unitNumber, b.unitNumber))] as [string, Unit[]]);
  }, [units]);

  const totals = useMemo(() => {
    let totalGuarantee = 0,
      totalOwed = 0,
      totalCredit = 0,
      totalPaid = 0,
      totalMonthlyRent = 0;
    units.forEach((u) => {
      if (u.contract) {
        totalGuarantee += Number((u.guaranteeRemaining ?? u.contract.guaranteeAmount) || 0);
        const outstanding = u.outstanding ?? 0;
        if (outstanding > 0) totalOwed += outstanding;
        totalCredit += u.prepaidCredit ?? 0;
        totalPaid += u.totalPaid ?? 0;
        if (u.contract.status === "ACTIVE" || !u.contract.status) {
          totalMonthlyRent += Number(u.contract.rentalAmount || 0);
        }
      }
    });
    return { totalGuarantee, totalOwed, totalCredit, totalPaid, totalMonthlyRent };
  }, [units]);

  const runMonthly = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/run-monthly"),
    onSuccess: () => {
      toast({ title: "Monthly ledger updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
  });

  const deleteUnit = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${apiBase}/units/${id}`),
    onSuccess: () => {
      toast({ title: "Unit deleted" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      setConfirmDeleteUnitId(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Cannot delete", description: e.message, variant: "destructive" });
      setConfirmDeleteUnitId(null);
    },
  });

  const openUnit = units.find((u) => u.id === openUnitId) ?? null;
  const confirmDeleteUnit = confirmDeleteUnitId ? (units.find((u) => u.id === confirmDeleteUnitId) ?? null) : null;

  // ── Bulk payment selection state ──────────────────────────
  const [selectedContractIds, setSelectedContractIds] = useState<Set<number>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = useState(false);

  const contractedUnits = useMemo(() => units.filter((u) => u.contract && !u.isShared), [units]);

  const toggleSelect = (contractId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedContractIds((prev) => {
      const next = new Set(prev);
      if (next.has(contractId)) next.delete(contractId);
      else next.add(contractId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedContractIds.size === contractedUnits.length) {
      setSelectedContractIds(new Set());
    } else {
      setSelectedContractIds(new Set(contractedUnits.map((u) => u.contract!.id)));
    }
  };

  const selectedUnits = useMemo(
    () => units.filter((u) => u.contract && selectedContractIds.has(u.contract.id)),
    [units, selectedContractIds]
  );

  return (
    <ApiBaseCtx.Provider value={apiBase}>
      <div className="p-4 space-y-4" data-testid={`page-${testIdPrefix}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            {pageIcon}
            <div>
              <PageHeader
                title={pageTitle}
                subtitle="Click any unit to manage payments, modify rent, post guarantee, or end the contract."
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {selectedContractIds.size > 0 && (
              <Button size="sm" onClick={() => setBulkPayOpen(true)} data-testid={`button-${testIdPrefix}-bulk-pay`}>
                <CreditCard className="h-4 w-4 mr-1" />
                Pay Selected ({selectedContractIds.size})
              </Button>
            )}
            {paymentsLogUrl && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(paymentsLogUrl)}
                data-testid={`button-${testIdPrefix}-payments-log`}
              >
                <ClipboardList className="h-4 w-4 mr-1" />
                Payments Log
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => runMonthly.mutate()}
              disabled={runMonthly.isPending}
              data-testid={`button-${testIdPrefix}-run-monthly`}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${runMonthly.isPending ? "animate-spin" : ""}`} />
              Run Monthly Update
            </Button>
            <Button onClick={() => setCreateUnitOpen(true)} size="sm" data-testid={`button-${testIdPrefix}-add-unit`}>
              <Plus className="h-4 w-4 mr-1" />
              Add {unitType === "WAREHOUSE" ? "Warehouse" : "Shop"}
            </Button>
          </div>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <Card>
            <CardHeader className="px-3 pt-3 pb-1">
              <CardTitle className="text-[10px] text-muted-foreground font-normal tracking-wide">TOTAL UNITS</CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="text-lg font-bold" data-testid={`stat-${testIdPrefix}-total-units`}>
                {units.length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="px-3 pt-3 pb-1">
              <CardTitle className="text-[10px] text-muted-foreground font-normal tracking-wide">
                RENT / MONTH
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div
                className="text-lg font-bold text-blue-600 dark:text-blue-400"
                data-testid={`stat-${testIdPrefix}-monthly-rent`}
              >
                ${fmtMoney(totals.totalMonthlyRent)}
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">expected from active leases</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="px-3 pt-3 pb-1">
              <CardTitle className="text-[10px] text-muted-foreground font-normal tracking-wide">
                TOTAL GUARANTEE
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="text-lg font-bold" data-testid={`stat-${testIdPrefix}-total-guarantee`}>
                ${fmtMoney(totals.totalGuarantee)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="px-3 pt-3 pb-1">
              <CardTitle className="text-[10px] text-muted-foreground font-normal tracking-wide">TOTAL PAID</CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div
                className={`text-lg font-bold ${totals.totalPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                data-testid={`stat-${testIdPrefix}-total-paid`}
              >
                ${fmtMoney(totals.totalPaid)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0 flex h-full">
              <div className="flex-1 px-3 pt-3 pb-3">
                <p className="text-[10px] text-muted-foreground font-normal tracking-wide">OUTSTANDING</p>
                <div
                  className="text-lg font-bold text-red-600 dark:text-red-400 mt-1"
                  data-testid={`stat-${testIdPrefix}-total-outstanding`}
                >
                  ${fmtMoney(totals.totalOwed)}
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">owed by tenants</p>
              </div>
              <div className="w-px bg-border self-stretch my-2" />
              <div className="flex-1 px-3 pt-3 pb-3">
                <p className="text-[10px] text-muted-foreground font-normal tracking-wide">CREDIT</p>
                <div
                  className="text-lg font-bold text-green-600 dark:text-green-400 mt-1"
                  data-testid={`stat-${testIdPrefix}-total-credit`}
                >
                  ${fmtMoney(totals.totalCredit)}
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">advance / overpaid</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-280px)]">
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading units…</div>
              ) : grouped.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No {unitType === "WAREHOUSE" ? "warehouses" : "shops"} yet. Add your first unit above.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b sticky top-0 z-30">
                    <tr>
                      <th className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={contractedUnits.length > 0 && selectedContractIds.size === contractedUnits.length}
                          onCheckedChange={toggleSelectAll}
                          data-testid={`checkbox-${testIdPrefix}-select-all`}
                          aria-label="Select all"
                        />
                      </th>
                      <th className="text-left px-3 py-2 font-semibold">Unit</th>
                      <th className="text-left px-3 py-2 font-semibold">Dimensions</th>
                      <th className="text-left px-3 py-2 font-semibold">Tenant</th>
                      <th className="text-left px-3 py-2 font-semibold">Note</th>
                      <th className="text-right px-3 py-2 font-semibold">Monthly Rent</th>
                      <th className="text-right px-3 py-2 font-semibold">Guarantee</th>
                      <th className="text-right px-3 py-2 font-semibold">Outstanding</th>
                      <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Scheduled</th>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Next Billing</th>
                      <th className="text-left px-3 py-2 font-semibold">Start</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map(([group, groupUnits], gIdx) => {
                      const GROUP_PALETTE = [
                        { headerBg: "#1d4ed8", headerText: "#fff", r: 29, g: 78, b: 216 },
                        { headerBg: "#047857", headerText: "#fff", r: 4, g: 120, b: 87 },
                        { headerBg: "#7c3aed", headerText: "#fff", r: 124, g: 58, b: 237 },
                        { headerBg: "#b45309", headerText: "#fff", r: 180, g: 83, b: 9 },
                        { headerBg: "#be123c", headerText: "#fff", r: 190, g: 18, b: 60 },
                        { headerBg: "#0e7490", headerText: "#fff", r: 14, g: 116, b: 144 },
                        { headerBg: "#c2410c", headerText: "#fff", r: 194, g: 65, b: 12 },
                        { headerBg: "#4d7c0f", headerText: "#fff", r: 77, g: 124, b: 15 },
                      ];
                      const p = GROUP_PALETTE[gIdx % GROUP_PALETTE.length];
                      const rowBgEven = `rgba(${p.r},${p.g},${p.b},0.06)`;
                      const rowBgOdd = `rgba(${p.r},${p.g},${p.b},0.12)`;
                      const unitNumBg = `rgba(${p.r},${p.g},${p.b},0.18)`;
                      const unitNumColor = p.headerBg;
                      return (
                        <>
                          <tr key={`grp-${group}`} className="border-t">
                            <td
                              colSpan={12}
                              className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-center"
                              style={{ backgroundColor: p.headerBg, color: p.headerText }}
                            >
                              {group}
                            </td>
                          </tr>
                          {groupUnits.map((u, uIdx) => (
                            <tr
                              key={u.id}
                              className="border-t cursor-pointer transition-colors"
                              style={{ backgroundColor: uIdx % 2 === 0 ? rowBgEven : rowBgOdd }}
                              onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(0.93)")}
                              onMouseLeave={(e) => (e.currentTarget.style.filter = "")}
                              onClick={() => setOpenUnitId(u.id)}
                              data-testid={`row-unit-${u.id}`}
                            >
                              <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                                {u.contract && !u.isShared && (
                                  <Checkbox
                                    checked={selectedContractIds.has(u.contract.id)}
                                    onCheckedChange={() =>
                                      toggleSelect(u.contract!.id, { stopPropagation: () => {} } as React.MouseEvent<
                                        Element,
                                        MouseEvent
                                      >)
                                    }
                                    onClick={(e) => e.stopPropagation()}
                                    data-testid={`checkbox-unit-${u.id}`}
                                    aria-label={`Select ${u.unitNumber}`}
                                  />
                                )}
                              </td>
                              <td
                                className="px-3 py-2 font-mono text-xs font-bold"
                                style={{ backgroundColor: unitNumBg, color: unitNumColor }}
                              >
                                {u.unitNumber}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                {u.dimensions ? (
                                  <span className="font-medium text-foreground">{u.dimensions}</span>
                                ) : u.size ? (
                                  <span>{u.size}</span>
                                ) : (
                                  <span>—</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {u.contract ? (
                                  <span className="font-medium flex items-center gap-1.5 flex-wrap">
                                    {u.contract.tenantName}
                                    {u.contract.isInternal && (
                                      <Badge className="text-xs bg-violet-600 text-white">Internal</Badge>
                                    )}
                                    {u.isShared && (
                                      <Badge
                                        className="text-xs bg-sky-600 text-white"
                                        title={u.ownerCompanyName ? `From: ${u.ownerCompanyName}` : undefined}
                                      >
                                        Shared
                                      </Badge>
                                    )}
                                  </span>
                                ) : (
                                  <Badge variant="secondary" className="text-xs">
                                    Vacant
                                  </Badge>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {u.contract ? (
                                  <NoteCell
                                    contractId={u.contract.id}
                                    note={u.contract.notes}
                                    testId={`unit-${u.id}`}
                                  />
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {u.contract ? fmtMoneyCurrency(u.contract.rentalAmount, u.contract.currency) : "—"}
                              </td>
                              <td
                                className={`px-3 py-2 text-right tabular-nums font-semibold ${
                                  u.contract && Number(u.contract.guaranteeAmount) > 0
                                    ? u.contract.guaranteePostedToStatement
                                      ? "text-green-600 dark:text-green-400"
                                      : "text-red-600 dark:text-red-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {u.contract
                                  ? fmtMoneyCurrency(
                                      (
                                        u as unknown as Unit & {
                                          guaranteeRemaining: string | number | null | undefined;
                                        }
                                      ).guaranteeRemaining ?? u.contract.guaranteeAmount,
                                      u.contract.currency
                                    )
                                  : "—"}
                              </td>
                              <td
                                className={`px-3 py-2 text-right tabular-nums font-semibold ${(u.outstanding ?? 0) > 0 ? "text-red-600 dark:text-red-400" : (u as { prepaidCredit: 0 }).prepaidCredit > 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                              >
                                {u.outstanding !== null
                                  ? fmtMoneyCurrency(
                                      (u.outstanding ?? 0) > 0
                                        ? u.outstanding!
                                        : (u as { prepaidCredit: 0 }).prepaidCredit > 0
                                          ? u.prepaidCredit
                                          : 0,
                                      u.contract?.currency
                                    )
                                  : "—"}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground text-xs">
                                {(u as { scheduledAmount: 0 }).scheduledAmount > 0
                                  ? fmtMoneyCurrency(u.scheduledAmount, u.contract?.currency)
                                  : "—"}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                {u.nextBillingDate ? format(new Date(u.nextBillingDate + "T00:00:00Z"), "dd MMM") : "—"}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
                                {u.contract ? format(new Date(u.contract.startDate), "dd MMM yyyy") : "—"}
                              </td>
                              <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1">
                                  {!u.isShared && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="text-muted-foreground hover:text-destructive"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setConfirmDeleteUnitId(u.id);
                                      }}
                                      data-testid={`button-delete-unit-${u.id}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  )}
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>

        {bulkPayOpen && selectedUnits.length > 0 && (
          <BulkPaymentDialog
            units={selectedUnits}
            cashAccounts={cashAccounts}
            testIdPrefix={testIdPrefix}
            onClose={() => setBulkPayOpen(false)}
            onSuccess={() => setSelectedContractIds(new Set())}
          />
        )}

        {openUnit && (
          <UnitActionDialog
            unit={openUnit}
            cashAccounts={cashAccounts}
            onClose={() => setOpenUnitId(null)}
            unitType={unitType}
            testIdPrefix={testIdPrefix}
          />
        )}

        {createUnitOpen && (
          <CreateUnitDialog unitType={unitType} onClose={() => setCreateUnitOpen(false)} testIdPrefix={testIdPrefix} />
        )}

        {/* Confirm delete unit dialog */}
        {confirmDeleteUnit && (
          <Dialog open onOpenChange={(o) => !o && setConfirmDeleteUnitId(null)}>
            <DialogContent data-testid={`dialog-${testIdPrefix}-confirm-delete`}>
              <DialogHeader>
                <DialogTitle>Delete Unit {confirmDeleteUnit.unitNumber}?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This will permanently remove unit{" "}
                <span className="font-semibold text-foreground">{confirmDeleteUnit.unitNumber}</span> from the list.
                {confirmDeleteUnit.contract ? (
                  <span className="block mt-1 text-destructive font-medium">
                    This unit has an active contract — end it first before deleting.
                  </span>
                ) : (
                  <span className="block mt-1">The unit is currently vacant and can be safely deleted.</span>
                )}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDeleteUnitId(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteUnit.mutate(confirmDeleteUnit.id)}
                  disabled={deleteUnit.isPending || !!confirmDeleteUnit.contract}
                  data-testid={`button-${testIdPrefix}-confirm-delete-submit`}
                >
                  {deleteUnit.isPending ? "Deleting…" : "Delete Unit"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </ApiBaseCtx.Provider>
  );
}
