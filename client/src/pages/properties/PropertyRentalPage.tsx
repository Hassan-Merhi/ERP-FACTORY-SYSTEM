import type { ClientErrorLike } from "@/lib/clientError";
import { Fragment, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  ChevronRight,
  RefreshCw,
  Trash2,
  ClipboardList,
  CreditCard,
  BookCheck,
  MapPin,
  Building2,
  UserRound,
  CalendarDays,
  Pencil,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { useAppMode } from "@/contexts/AppModeContext";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";

import type { CashAccount, Props, Unit } from "./property-rental/types";
import { fmtMoney, fmtMoneyCurrency } from "./property-rental/utils";
import { ApiBaseCtx } from "./property-rental/shared";
import { NoteCell } from "./property-rental/components/NoteCell";
import { CreateUnitDialog } from "./property-rental/components/CreateUnitDialog";
import { UnitActionDialog } from "./property-rental/components/UnitActionDialog";
import { BulkPaymentDialog } from "./property-rental/components/BulkPaymentDialog";
import { RentalUnitCards } from "./property-rental/components/RentalUnitCards";
import { RentalSummaryTiles } from "./property-rental/components/RentalSummaryTiles";
import { RenameGroupDialog } from "./property-rental/components/RenameGroupDialog";
import { ErpMobileActionsMenu, ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import {
  HISTORICAL_RENT_COMPANY,
  historicalRentSnapshotTotal,
  type HistoricalRentPayment,
} from "./property-rental/historicalRentSnapshot";
export default function PropertyRentalPage({
  unitType,
  pageTitle,
  pageIcon,
  testIdPrefix,
  apiBase = "/api/properties/rental",
  paymentsLogUrl,
}: Props) {
  const { selectedCompany } = useCompany();
  const isPropertiesRental = apiBase === "/api/properties/rental";
  const { toast } = useToast();
  const appMode = useAppMode();
  const [, navigate] = useLocation();
  const [openUnitId, setOpenUnitId] = useState<number | null>(null);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [confirmDeleteUnitId, setConfirmDeleteUnitId] = useState<number | null>(null);
  const [renameGroup, setRenameGroup] = useState<{ name: string; unitId: number; count: number } | null>(null);

  const { data: units = [], isLoading } = useQuery<Unit[]>({
    queryKey: [apiBase + "/units", { unitType, companyId: selectedCompany?.id }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units?unitType=${unitType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load units");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  // Dated, voucher-backed actual rent; no synthetic payment or ledger adjustment.
  const showHistoricalPaid =
    apiBase === "/api/properties/rental" &&
    unitType === "WAREHOUSE" &&
    selectedCompany?.name === HISTORICAL_RENT_COMPANY;
  const {
    data: historicalPayments = [],
    isLoading: historicalLoading,
    isError: historicalError,
  } = useQuery<HistoricalRentPayment[]>({
    queryKey: [apiBase + "/payments", { companyId: selectedCompany?.id, view: "warehouse-reconciliation" }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/payments?view=warehouse-reconciliation`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load historical warehouse rent");
      return res.json();
    },
    enabled: !!selectedCompany && showHistoricalPaid,
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

  const propertiesCashbox = isPropertiesRental
    ? cashAccounts.find((account) => account.code === "PROP-RENT-CASH")
    : undefined;
  const ensureCashbox = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/cashbox/ensure", {}),
    onSuccess: () => {
      toast({
        title: "Properties cashbox ready",
        description: "The new cashbox starts at zero. Historical balances remain unchanged.",
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/cash-accounts", selectedCompany?.id] });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Cashbox setup failed", description: e.message, variant: "destructive" }),
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
      // Factory projections are references, not Properties receivables or deposits.
      if (u.isInternalLeaseProjection) return;
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

  const datedHistoricalPaid = useMemo(() => historicalRentSnapshotTotal(historicalPayments), [historicalPayments]);
  const summaryPaid = showHistoricalPaid ? datedHistoricalPaid : totals.totalPaid;
  const paidLabel = showHistoricalPaid ? "TOTAL PAID THROUGH 26 OCT" : "TOTAL PAID";
  const paidValue =
    showHistoricalPaid && (historicalLoading || historicalError) ? "Unavailable" : "$" + fmtMoney(summaryPaid);

  const runMonthly = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/run-monthly"),
    onSuccess: () => {
      toast({ title: "Monthly ledger updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
  });

  // Wave 18 A: the units page no longer posts on load. Due scheduled payments and
  // accruals post from the daily job; Admin/Owner can post them now (same code
  // path, dated by the company's business date, audited).
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const currentRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canPostDue = currentRole === "Admin" || currentRole === "Owner" || currentRole === "Developer";
  const postDue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", apiBase + "/accruals/post-due");
      return (await res.json()) as { accrued: number; scheduledPaymentsPosted: number; skipped: unknown[] };
    },
    onSuccess: (result) => {
      toast({
        title: "Due rent posted",
        description: `Rows accrued: ${result.accrued}; scheduled payments posted: ${result.scheduledPaymentsPosted}; skipped (closed period): ${result.skipped.length}`,
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Could not post due accruals", description: e.message, variant: "destructive" });
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

  const editableUnitInGroup = (groupUnits: Unit[]) =>
    groupUnits.find((u) => u.unitType === unitType && !u.isShared && !u.isInternalLeaseProjection);
  const openRenameGroup = (name: string, groupUnits: Unit[]) => {
    const unit = editableUnitInGroup(groupUnits);
    if (!isPropertiesRental || !unit) return;
    setRenameGroup({
      name,
      unitId: unit.id,
      count: groupUnits.filter((u) => u.unitType === unitType && !u.isShared && !u.isInternalLeaseProjection).length,
    });
  };

  const openUnit = units.find((u) => u.id === openUnitId) ?? null;
  const confirmDeleteUnit = confirmDeleteUnitId ? (units.find((u) => u.id === confirmDeleteUnitId) ?? null) : null;

  // ── Bulk payment selection state ──────────────────────────
  const [selectedContractIds, setSelectedContractIds] = useState<Set<number>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = useState(false);

  const contractedUnits = useMemo(
    () => units.filter((u) => u.contract && !u.isShared && !u.isInternalLeaseProjection),
    [units]
  );

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

  // ERP and Properties render the shared page-header contract; Factory keeps its hub strip.
  const isErp = appMode === "erp" || appMode === "properties";
  const isFactoryShopTable = testIdPrefix === "factory-rental-shops";
  const isPhoneLayout = useErpPhoneLayout();
  // Phones in every mode: cards instead of the twelve-column table, and one primary action plus
  // a menu.
  const phoneCards = isPhoneLayout;
  const phoneHeaderActions = (
    <>
      {selectedContractIds.size > 0 && (
        <Button onClick={() => setBulkPayOpen(true)} data-testid={`button-${testIdPrefix}-bulk-pay`}>
          <CreditCard className="h-4 w-4 me-1" />
          Pay Selected ({selectedContractIds.size})
        </Button>
      )}
      <Button onClick={() => setCreateUnitOpen(true)} data-testid={`button-${testIdPrefix}-add-unit`}>
        <Plus className="h-4 w-4 me-1" />
        {unitType === "WAREHOUSE" ? "Add Warehouse" : "Add Shop"}
      </Button>
      <ErpMobileActionsMenu
        data-testid={`button-${testIdPrefix}-actions`}
        actions={[
          !!paymentsLogUrl && {
            label: "Payments Log",
            icon: ClipboardList,
            onSelect: () => navigate(paymentsLogUrl),
            testId: `button-${testIdPrefix}-payments-log`,
          },
          {
            label: "Run Monthly Update",
            icon: RefreshCw,
            onSelect: () => runMonthly.mutate(),
            disabled: runMonthly.isPending,
            testId: `button-${testIdPrefix}-run-monthly`,
          },
          isPropertiesRental &&
            canPostDue &&
            !propertiesCashbox && {
              label: "Create Properties Cashbox",
              icon: Plus,
              onSelect: () => ensureCashbox.mutate(),
              disabled: ensureCashbox.isPending,
              testId: `button-${testIdPrefix}-create-cashbox`,
            },
          canPostDue && {
            label: "Post due accruals now",
            icon: BookCheck,
            onSelect: () => postDue.mutate(),
            disabled: postDue.isPending,
            testId: `button-${testIdPrefix}-post-due`,
          },
          contractedUnits.length > 0 && {
            label: selectedContractIds.size === contractedUnits.length ? "Clear selection" : "Select all",
            onSelect: toggleSelectAll,
            separated: true,
            testId: `checkbox-${testIdPrefix}-select-all`,
          },
        ]}
      />
    </>
  );
  const headerActions = (
    <>
      {isPropertiesRental && canPostDue && !propertiesCashbox && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => ensureCashbox.mutate()}
          disabled={ensureCashbox.isPending}
          data-testid={`button-${testIdPrefix}-create-cashbox`}
        >
          <Plus className="h-4 w-4 mr-1" /> Create Properties Cashbox
        </Button>
      )}
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
      {canPostDue && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => postDue.mutate()}
          disabled={postDue.isPending}
          data-testid={`button-${testIdPrefix}-post-due`}
        >
          <BookCheck className="h-4 w-4 mr-1" />
          Post due accruals now
        </Button>
      )}
      <Button onClick={() => setCreateUnitOpen(true)} size="sm" data-testid={`button-${testIdPrefix}-add-unit`}>
        <Plus className="h-4 w-4 mr-1" />
        {unitType === "WAREHOUSE" ? "Add Warehouse" : "Add Shop"}
      </Button>
    </>
  );

  return (
    <ApiBaseCtx.Provider value={apiBase}>
      <div className={isErp ? "space-y-4 sm:p-4" : "p-4 space-y-4"} data-testid={`page-${testIdPrefix}`}>
        {isErp ? (
          <PageHeader
            title={pageTitle}
            subtitle="Click any unit to manage payments, modify rent, post guarantee, or end the contract."
            icon={pageIcon}
          >
            {phoneCards ? phoneHeaderActions : headerActions}
          </PageHeader>
        ) : (
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
            <div className="flex items-center gap-2 flex-wrap">{phoneCards ? phoneHeaderActions : headerActions}</div>
          </div>
        )}

        {isPropertiesRental && units.some((unit) => unit.isInternalLeaseProjection) && (
          <p className="text-xs text-muted-foreground" data-testid="properties-factory-internal-lease-note">
            Internal ERP/Factory leases appear for reference only. They are excluded from Properties rent and balance
            totals; manage payments and accounting from the originating rental module.
          </p>
        )}
        {isPropertiesRental && (
          <p className="text-xs text-muted-foreground" data-testid="properties-rent-cashbox-status">
            {propertiesCashbox
              ? "New receipts can be posted to Properties Rent Cashbox. Historical balances and transfers stay as recorded; no automatic intercompany movement."
              : "Set up a zero-opening Properties cashbox for new receipts; historical balances are not changed."}
          </p>
        )}

        {phoneCards ? (
          <ErpMobileSummaryGrid
            data-testid={`summary-${testIdPrefix}`}
            items={[
              { label: "TOTAL UNITS", value: units.length },
              {
                label: "RENT / MONTH",
                value: `$${fmtMoney(totals.totalMonthlyRent)}`,
                valueClassName: "text-blue-600 dark:text-blue-400",
              },
              {
                label: isPropertiesRental ? "TO COLLECT" : "OUTSTANDING",
                value: `$${fmtMoney(totals.totalOwed)}`,
                valueClassName: isPropertiesRental
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400",
              },
              {
                label: isPropertiesRental ? "OWED TO TENANTS" : "CREDIT",
                value: `$${fmtMoney(totals.totalCredit)}`,
                valueClassName: isPropertiesRental
                  ? "text-red-600 dark:text-red-400"
                  : "text-green-600 dark:text-green-400",
              },
              {
                label: isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE",
                value: `$${fmtMoney(totals.totalGuarantee)}`,
                valueClassName: isPropertiesRental ? "text-red-600 dark:text-red-400" : undefined,
              },
              { label: paidLabel, value: paidValue },
            ]}
          />
        ) : (
          <RentalSummaryTiles
            testIdPrefix={testIdPrefix}
            unitCount={units.length}
            totals={totals}
            isPropertiesRental={isPropertiesRental}
            paidLabel={paidLabel}
            paidValue={paidValue}
          />
        )}

        {phoneCards ? (
          isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading units…</div>
          ) : grouped.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-muted-foreground">
              {unitType === "WAREHOUSE"
                ? "No warehouses yet. Add your first unit above."
                : "No shops yet. Add your first unit above."}
            </div>
          ) : (
            <RentalUnitCards
              landlordView={isPropertiesRental}
              grouped={grouped}
              selectedContractIds={selectedContractIds}
              onToggleSelect={(contractId) =>
                toggleSelect(contractId, { stopPropagation: () => {} } as React.MouseEvent<Element, MouseEvent>)
              }
              onOpenUnit={setOpenUnitId}
              onDeleteUnit={setConfirmDeleteUnitId}
              onRenameGroup={isPropertiesRental ? openRenameGroup : undefined}
              canRenameGroup={(groupUnits) => !!editableUnitInGroup(groupUnits)}
            />
          )
        ) : (
          /* Main table */
          <Card className={isFactoryShopTable ? "factory-rentals-table-shell" : undefined}>
            <CardContent className={isFactoryShopTable ? "p-2 sm:p-3" : "p-0"}>
              <div data-horizontal-scroll="true" className="overflow-x-auto">
                {isLoading ? (
                  <div className="p-8 text-center text-muted-foreground">Loading units…</div>
                ) : grouped.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    {unitType === "WAREHOUSE"
                      ? "No warehouses yet. Add your first unit above."
                      : "No shops yet. Add your first unit above."}
                  </div>
                ) : (
                  <table className={isFactoryShopTable ? "factory-rentals-table w-full text-sm" : "w-full text-sm"}>
                    <thead className="bg-muted border-b sticky top-0 z-30">
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
                        <th className="text-right px-3 py-2 font-semibold">
                          {isPropertiesRental ? "Tenant Balance" : "Outstanding"}
                        </th>
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
                          <Fragment key={group}>
                            <tr
                              key={`grp-${group}`}
                              className={isFactoryShopTable ? "factory-rentals-location-row" : "border-t"}
                            >
                              <td
                                colSpan={12}
                                className={
                                  isFactoryShopTable
                                    ? "factory-rentals-location-cell"
                                    : "px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-center"
                                }
                                style={
                                  isFactoryShopTable ? undefined : { backgroundColor: p.headerBg, color: p.headerText }
                                }
                              >
                                {isFactoryShopTable ? (
                                  <div
                                    className="factory-rentals-location-bar"
                                    style={{ background: `linear-gradient(110deg, ${p.headerBg}, ${p.headerBg}df)` }}
                                  >
                                    <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                                    <span>{group}</span>
                                    <span className="factory-rentals-location-count">
                                      {groupUnits.length} {groupUnits.length === 1 ? "unit" : "units"}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="inline-flex items-center justify-center gap-2">
                                    <span>{group}</span>
                                    {isPropertiesRental && editableUnitInGroup(groupUnits) && (
                                      <button
                                        type="button"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openRenameGroup(group, groupUnits);
                                        }}
                                        title={`Rename ${group}`}
                                        aria-label={`Rename location group ${group}`}
                                        data-testid={`button-${testIdPrefix}-rename-group-${gIdx}`}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </span>
                                )}
                              </td>
                            </tr>
                            {groupUnits.map((u, uIdx) => (
                              <tr
                                key={u.id}
                                className={
                                  isFactoryShopTable
                                    ? `factory-rentals-unit-row cursor-pointer${u.contract && selectedContractIds.has(u.contract.id) ? " factory-rentals-unit-row-selected" : ""}`
                                    : "border-t cursor-pointer transition-colors"
                                }
                                style={
                                  isFactoryShopTable
                                    ? ({ "--factory-rentals-rgb": `${p.r}, ${p.g}, ${p.b}` } as React.CSSProperties)
                                    : { backgroundColor: uIdx % 2 === 0 ? rowBgEven : rowBgOdd }
                                }
                                onMouseEnter={(e) => {
                                  if (!isFactoryShopTable) e.currentTarget.style.filter = "brightness(0.93)";
                                }}
                                onMouseLeave={(e) => {
                                  if (!isFactoryShopTable) e.currentTarget.style.filter = "";
                                }}
                                onClick={() => setOpenUnitId(u.id)}
                                data-testid={`row-unit-${u.id}`}
                              >
                                <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                                  {u.contract && !u.isShared && !u.isInternalLeaseProjection && (
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
                                  className={isFactoryShopTable ? "px-3 py-2" : "px-3 py-2 font-mono text-xs font-bold"}
                                  style={
                                    isFactoryShopTable ? undefined : { backgroundColor: unitNumBg, color: unitNumColor }
                                  }
                                >
                                  {isFactoryShopTable ? (
                                    <span
                                      className="factory-rentals-unit-pill"
                                      style={{ color: p.headerBg, backgroundColor: `rgba(${p.r},${p.g},${p.b},0.15)` }}
                                    >
                                      <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                      {u.unitNumber}
                                    </span>
                                  ) : (
                                    u.unitNumber
                                  )}
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
                                      {isFactoryShopTable && (
                                        <UserRound
                                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                          aria-hidden="true"
                                        />
                                      )}
                                      {u.contract.tenantName}
                                      {u.contract.isInternal && (
                                        <Badge className="text-xs bg-violet-600 text-white">Internal</Badge>
                                      )}
                                      {u.isInternalLeaseProjection && (
                                        <Badge className="text-xs bg-violet-600 text-white">
                                          {u.sourceModule === "ERP" ? "ERP reference" : "Factory reference"}
                                        </Badge>
                                      )}
                                      {u.isShared && !u.isInternalLeaseProjection && (
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
                                    u.isInternalLeaseProjection ? (
                                      <span className="text-xs text-muted-foreground">{u.contract.notes || "—"}</span>
                                    ) : (
                                      <NoteCell
                                        contractId={u.contract.id}
                                        note={u.contract.notes}
                                        testId={`unit-${u.id}`}
                                      />
                                    )
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
                                        ? isPropertiesRental
                                          ? "text-red-600 dark:text-red-400"
                                          : "text-green-600 dark:text-green-400"
                                        : isPropertiesRental
                                          ? "text-amber-600 dark:text-amber-400"
                                          : "text-red-600 dark:text-red-400"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  <span className={isFactoryShopTable ? "factory-rentals-money-pill" : undefined}>
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
                                  </span>
                                </td>
                                <td
                                  className={`px-3 py-2 text-right tabular-nums font-semibold ${(u.outstanding ?? 0) > 0 ? (isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : (u.prepaidCredit ?? 0) > 0 ? (isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400") : "text-muted-foreground"}`}
                                >
                                  <span className={isFactoryShopTable ? "factory-rentals-money-pill" : undefined}>
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
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground text-xs">
                                  {(u as { scheduledAmount: 0 }).scheduledAmount > 0
                                    ? fmtMoneyCurrency(u.scheduledAmount, u.contract?.currency)
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                  <span className="factory-rentals-date">
                                    {isFactoryShopTable && (
                                      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    )}
                                    {u.nextBillingDate
                                      ? format(new Date(u.nextBillingDate + "T00:00:00Z"), "dd MMM")
                                      : "—"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                  <span className="factory-rentals-date">
                                    {isFactoryShopTable && (
                                      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    )}
                                    {u.contract ? format(new Date(u.contract.startDate), "dd MMM yyyy") : "—"}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-1">
                                    {!u.isShared && !u.isInternalLeaseProjection && (
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
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </CardContent>
          </Card>
        )}

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

        {renameGroup && (
          <RenameGroupDialog
            apiBase={apiBase}
            testIdPrefix={testIdPrefix}
            group={renameGroup}
            onClose={() => setRenameGroup(null)}
          />
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
