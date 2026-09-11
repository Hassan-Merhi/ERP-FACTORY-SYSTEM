import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Building2,
  ChevronDown,
  FileText,
  Link2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Trash2,
  Users,
  Package,
} from "lucide-react";
import { StatementResponse, SupplierWithBalance } from "./factorySupplierTypes";
import { LinkedSupplierExposure } from "./LinkedSupplierExposure";
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

interface StatementDisplayRow {
  key: string;
  date: string;
  type: "purchase" | "payment" | "fx" | "commission";
  ref: string;
  detail?: string;
  amount: string;
  amountVal: number;
  rowCc: string;
  status?: string;
  optional?: boolean;
  amountIsNeg?: boolean;
  onMove?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}
import { CurrencyPools } from "./CurrencyPools";
import { SupplierStatementRows } from "./SupplierStatementRows";

interface SupplierStatementProps {
  statementSupplierId: number;
  statementData: StatementResponse | undefined;
  statementLoading: boolean;
  statementError: boolean;
  supplierIncludeOtw: boolean;
  setSupplierIncludeOtw: (val: boolean) => void;
  collapsedStmtSections: Set<string>;
  toggleStmtSection: (key: string) => void;
  isBrokerStatement: boolean;
  statementReturnToParent: boolean;
  setStatementSupplierId: (id: number | null) => void;
  setStatementReturnToParent: (val: boolean) => void;
  openFxConversionDialog: (
    fromSupplierId: number,
    toSupplierId: number,
    currencyCode: string,
    netPayable: string,
    totalCommission?: string
  ) => void;
  formatNum: (val: string) => string;
  formatDate: (val: string) => string;
  formatKg: (val: string) => string;
  today: string;
  fxConversionOpen: boolean;
  setFxConversionOpen: (val: boolean) => void;
  fxConversionForm: SuppliersModel["fxConversionForm"];
  setFxConversionForm: SuppliersModel["setFxConversionForm"];
  fxSourceType: "supplier" | "commission" | "both";
  setFxSourceType: (val: "supplier" | "commission" | "both") => void;
  allSuppliers: SupplierWithBalance[];
  subAccountsByParent: Record<number, SupplierWithBalance[]>;
  wrapAdminAction: (fn: () => void, title: string) => void;
  deleteFxTransferMutation: SuppliersModel["deleteFxTransferMutation"];
  statDateFilter: "all" | "today" | "yesterday" | "this_month" | "this_year";
  setStatDateFilter: (val: "all" | "today" | "yesterday" | "this_month" | "this_year") => void;
  onEditPayment: (payment: Record<string, unknown>) => void;
  onDeletePayment: (id: number) => void;
  setEditObComm: SuppliersModel["setEditObComm"];
  statusColor: SuppliersModel["statusColor"];
  statusDisplayLabel: (status: string) => string;
  typeBadge: (type: string) => React.ReactNode;
  displayedRows: StatementDisplayRow[];
  balanceByKey: Record<string, { bal: number; cc: string }>;
  sfTotalPurchases: number;
  sfTotalPayments: number;
  sfPurchasesQty: number;
  sfTxCount: number;
  currencyTotals: Record<string, number>;
  primaryCc: string;
  onRenameSupplier?: (id: number, newName: string) => void;
  onDeleteSupplier?: (id: number) => void;
}

export function SupplierStatement({
  statementSupplierId,
  statementData,
  statementLoading,
  statementError,
  supplierIncludeOtw,
  setSupplierIncludeOtw,
  collapsedStmtSections,
  toggleStmtSection,
  isBrokerStatement,
  statementReturnToParent,
  setStatementSupplierId,
  setStatementReturnToParent,
  openFxConversionDialog,
  formatNum,
  formatDate,
  formatKg,
  today,
  fxConversionOpen: _fxConversionOpen,
  setFxConversionOpen,
  fxConversionForm: _fxConversionForm,
  setFxConversionForm,
  fxSourceType: _fxSourceType,
  setFxSourceType,
  allSuppliers: _allSuppliers,
  subAccountsByParent,
  wrapAdminAction,
  deleteFxTransferMutation,
  statDateFilter,
  setStatDateFilter,
  onEditPayment,
  onDeletePayment,
  setEditObComm: _setEditObComm,
  statusColor,
  statusDisplayLabel,
  typeBadge,
  displayedRows,
  balanceByKey,
  sfTotalPurchases,
  sfTotalPayments,
  sfPurchasesQty,
  sfTxCount,
  currencyTotals,
  primaryCc,
  onRenameSupplier,
  onDeleteSupplier,
}: SupplierStatementProps) {
  const [showRename, setShowRename] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  if (statementLoading) {
    return (
      <div className="space-y-4">
        <div className="text-center py-8 text-muted-foreground">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading statement...</p>
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (statementError) {
    return (
      <div className="rounded-xl border p-8 text-center text-muted-foreground">
        <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-lg font-medium">Could not load statement</p>
        <p className="text-sm mt-1">Please go back and try again</p>
      </div>
    );
  }

  if (!statementData) return null;

  const activeSt = (statementData.statement || []).filter((c) => c.status !== "OFFLOADED");
  const activeContainerCount = activeSt.length;
  const activeKg = activeSt.reduce(
    (sum: number, c) => sum + parseFloat(c.actualReceivedKg || c.totalKg || "0"),
    0
  );
  const currencyGroups = statementData.currencyGroups || [];

  const ownMap: Record<string, { own: number; totalFreight: number }> = {};
  for (const g of currencyGroups) {
    const cc = g.currencyCode;
    if (!ownMap[cc]) ownMap[cc] = { own: 0, totalFreight: 0 };
    ownMap[cc].own += parseFloat(g.netPayable || "0");
    ownMap[cc].totalFreight += parseFloat(g.totalFreight || "0");
  }

  const renderBalCard = (cc: string, bal: number, label: string, testId: string, freight?: number) => {
    const isOverpaid = bal < -0.005;
    const isSettled = Math.abs(bal) <= 0.005;
    const ccPrefix = cc !== "USD" ? `${cc} ` : "$";
    return (
      <div key={`${testId}-${cc}`} className="rounded-xl border p-4">
        <div className="text-xs text-muted-foreground font-medium">
          {cc} {label}
        </div>
        <div
          className={`text-xl font-bold mt-1 tabular-nums ${isSettled ? "text-muted-foreground" : isOverpaid ? "text-green-600 dark:text-green-400" : ""}`}
          data-testid={`${testId}-${cc}`}
        >
          {isSettled ? (
            <>
              {ccPrefix}— <span className="text-sm font-normal">Settled</span>
            </>
          ) : isOverpaid ? (
            <>
              {ccPrefix}
              {formatNum(String(Math.abs(bal).toFixed(2)))} <span className="text-sm font-normal">CR</span>
            </>
          ) : (
            <>
              {ccPrefix}
              {formatNum(String(bal.toFixed(2)))}
            </>
          )}
        </div>
        {freight && freight > 0.005 && (
          <div className="text-xs text-orange-600 dark:text-orange-400 mt-1">
            incl. {ccPrefix}
            {formatNum(String(freight.toFixed(2)))} freight
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setStatementSupplierId(null);
            if (statementReturnToParent) {
              setStatementReturnToParent(false);
            }
          }}
          data-testid="button-back-suppliers"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-statement-supplier-name">
              {statementData.supplier.name}
            </h1>
            {statementData.supplier.parentId ? (
              <>
                <Badge variant="outline" className="text-xs">
                  <Link2 className="h-3 w-3 mr-1" />
                  Linked Supplier
                </Badge>
                {onRenameSupplier && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Rename supplier"
                    data-testid="button-rename-linked-supplier"
                    onClick={() => {
                      setRenameDraft(statementData.supplier.name);
                      setShowRename(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {onDeleteSupplier && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Delete supplier"
                    data-testid="button-delete-linked-supplier"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </>
            ) : statementData?.supplier &&
              !statementData.supplier.parentId &&
              subAccountsByParent[statementData.supplier.id]?.length ? (
              <Badge variant="secondary" className="text-xs">
                <Building2 className="h-3 w-3 mr-1" />
                Broker
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">Settlement Statement</p>
        </div>
        {!isBrokerStatement && (
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            data-testid="label-supplier-include-otw"
          >
            <Switch
              checked={supplierIncludeOtw}
              onCheckedChange={setSupplierIncludeOtw}
              data-testid="switch-supplier-include-otw"
            />
            <span className="text-xs font-normal text-muted-foreground">Include OTW containers</span>
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {!isBrokerStatement && (
          <>
            <div className="rounded-xl border p-4">
              <div className="text-xs text-muted-foreground">Active Containers</div>
              <div className="text-xl font-bold mt-1" data-testid="text-statement-total-containers">
                {activeContainerCount}
                {statementData.summary.totalContainers > activeContainerCount && (
                  <span className="text-sm font-normal text-muted-foreground ml-1">
                    / {statementData.summary.totalContainers} total
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-xl border p-4">
              <div className="text-xs text-muted-foreground">Active Weight</div>
              <div className="text-xl font-bold mt-1" data-testid="text-statement-total-kg">
                {formatKg(String(activeKg.toFixed(3)))}
              </div>
            </div>
          </>
        )}
        {Object.entries(ownMap).map(([cc, v]) =>
          renderBalCard(cc, v.own, "Net Balance", "text-statement-balance", v.totalFreight)
        )}
      </div>

      {statementData.supplier && !isBrokerStatement && (
        <div className="rounded-xl border overflow-hidden">
          <div
            className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
            onClick={() => toggleStmtSection("supplierDetails")}
          >
            <span className="text-sm font-semibold">Supplier Details</span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("supplierDetails") ? "" : "rotate-180"}`}
            />
          </div>
          {!collapsedStmtSections.has("supplierDetails") && (
            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                {statementData.supplier.contactPerson && (
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{statementData.supplier.contactPerson}</span>
                  </div>
                )}
                {statementData.supplier.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{statementData.supplier.phone}</span>
                  </div>
                )}
                {statementData.supplier.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{statementData.supplier.email}</span>
                  </div>
                )}
                {statementData.supplier.address && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{statementData.supplier.address}</span>
                  </div>
                )}
                {statementData.supplier.notes && (
                  <div className="flex items-start gap-2 sm:col-span-2">
                    <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <span className="text-muted-foreground">{statementData.supplier.notes}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {statementData.currencyGroups &&
        (statementData.currencyGroups.length > 1 ||
          (statementData.currencyGroups.length === 1 && statementData.currencyGroups[0].currencyCode !== "USD")) && (
          <CurrencyPools
            statementData={statementData}
            statementSupplierId={statementSupplierId}
            collapsedStmtSections={collapsedStmtSections}
            toggleStmtSection={toggleStmtSection}
            today={today}
            formatKg={formatKg}
            formatNum={formatNum}
            setFxSourceType={setFxSourceType}
            setFxConversionForm={setFxConversionForm}
            setFxConversionOpen={setFxConversionOpen}
            openFxConversionDialog={openFxConversionDialog}
          />
        )}

      {isBrokerStatement && (
        <LinkedSupplierExposure
          statementData={statementData}
          statementSupplierId={statementSupplierId}
          supplierIncludeOtw={supplierIncludeOtw}
          collapsedStmtSections={collapsedStmtSections}
          toggleStmtSection={toggleStmtSection}
          setStatementReturnToParent={setStatementReturnToParent}
          setStatementSupplierId={setStatementSupplierId}
          formatDate={formatDate}
          formatNum={formatNum}
          openFxConversionDialog={openFxConversionDialog}
        />
      )}

      {statementData.fxTransfers && statementData.fxTransfers.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          <div
            className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
            onClick={() => toggleStmtSection("fxTransfers")}
          >
            <span className="flex items-center gap-2 flex-1">
              <ArrowRightLeft className="h-4 w-4" />
              <span className="text-sm font-semibold">FX Settlement Log</span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("fxTransfers") ? "" : "rotate-180"}`}
              />
            </span>
          </div>
          {!collapsedStmtSections.has("fxTransfers") && (
            <div>
              <div className="table-responsive">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-32">Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">From</TableHead>
                      <TableHead className="text-right">Cost (USD)</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statementData.fxTransfers.map((f) => {
                      const isSelf = f.toSupplierId === f.fromSupplierId;
                      const isIncoming = f.toSupplierId === statementSupplierId;
                      const displayRate = parseFloat(f.fxRateToUsd) > 0 ? 1 / parseFloat(f.fxRateToUsd) : 0;
                      return (
                        <TableRow key={f.id}>
                          <TableCell className="text-sm">{formatDate(f.date)}</TableCell>
                          <TableCell className="text-sm">
                            {isSelf ? "Internal Settlement" : isIncoming ? "Transfer In" : "Transfer Out"}
                            {f.sourceType && <span className="ml-1 opacity-60">({f.sourceType})</span>}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {f.fromCurrencyCode} {formatNum(f.fromAmount)} @ {displayRate.toFixed(4)}
                          </TableCell>
                          <TableCell className="text-right text-sm font-bold tabular-nums">
                            ${formatNum(f.toAmountUsd)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              onClick={() =>
                                wrapAdminAction(() => deleteFxTransferMutation.mutate(f.id), "Delete FX Transfer")
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border overflow-hidden">
        <div
          className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 cursor-pointer hover-elevate"
          onClick={() => toggleStmtSection("allActivity")}
        >
          <span className="flex items-center gap-2 flex-1">
            <BookOpen className="h-4 w-4" />
            <span className="text-sm font-semibold">Account Ledger</span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${collapsedStmtSections.has("allActivity") ? "" : "rotate-180"}`}
            />
          </span>
        </div>
        {!collapsedStmtSections.has("allActivity") && (
          <div className="p-4">
            <SupplierStatementRows
              statementData={statementData}
              primaryCc={primaryCc}
              sfTotalPurchases={sfTotalPurchases}
              sfTotalPayments={sfTotalPayments}
              sfPurchasesQty={sfPurchasesQty}
              sfTxCount={sfTxCount}
              currencyTotals={currencyTotals}
              statDateFilter={statDateFilter}
              setStatDateFilter={setStatDateFilter}
              displayedRows={displayedRows}
              balanceByKey={balanceByKey}
              formatDate={formatDate}
              formatNum={formatNum}
              typeBadge={typeBadge}
              statusColor={statusColor}
              statusDisplayLabel={statusDisplayLabel}
              onEditPayment={onEditPayment}
              onDeletePayment={onDeletePayment}
            />
          </div>
        )}
      </div>

      {/* Rename dialog */}
      <Dialog open={showRename} onOpenChange={(v) => !v && setShowRename(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Supplier</DialogTitle>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder="New name"
            data-testid="input-rename-supplier"
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameDraft.trim()) {
                onRenameSupplier!(statementSupplierId, renameDraft.trim());
                setShowRename(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRename(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renameDraft.trim()) {
                  onRenameSupplier!(statementSupplierId, renameDraft.trim());
                  setShowRename(false);
                }
              }}
              disabled={!renameDraft.trim()}
              data-testid="button-confirm-rename"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={(v) => !v && setShowDeleteConfirm(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Supplier</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Permanently delete <span className="font-semibold text-foreground">{statementData.supplier.name}</span>?
            This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onDeleteSupplier!(statementSupplierId);
                setShowDeleteConfirm(false);
              }}
              data-testid="button-confirm-delete-supplier"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
