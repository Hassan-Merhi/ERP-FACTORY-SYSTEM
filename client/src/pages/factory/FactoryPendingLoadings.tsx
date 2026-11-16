import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Package,
  Play,
  Trash2,
  X,
  Undo2,
  Users,
  Truck,
  Weight,
  Search,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { keyStartsWith } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UNDO_TIMEOUT_MS, fmtKg } from "./FactoryPendingLoadingsTypes";
import { useFactoryPendingLoadingsState } from "./useFactoryPendingLoadingsState";
import {
  FactoryPendingLoadingsDialogSection,
  FactoryPendingLoadingsListPendingLoadings,
} from "./FactoryPendingLoadingsDialogSection";

export default function FactoryPendingLoadings() {
  const {
    canStartLoading,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    renderLoadCard,
    restoreMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  } = useFactoryPendingLoadingsState();

  return (
    <div className="flex h-full flex-col gap-4 bg-background px-3 py-4 sm:px-5">
      {/* Undo banners */}
      {undoItems.length > 0 && (
        <div className="space-y-2">
          {undoItems.map((item) => {
            const elapsed = Date.now() - item.cancelledAt;
            const remaining = Math.max(0, UNDO_TIMEOUT_MS - elapsed);
            const pct = (remaining / UNDO_TIMEOUT_MS) * 100;
            return (
              <div
                key={item.load.id}
                className="relative flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-3 dark:bg-amber-950/40"
                data-testid={`banner-undo-${item.load.id}`}
              >
                {/* Countdown bar */}
                <div
                  className="absolute bottom-0 left-0 h-0.5 bg-amber-400 transition-none"
                  style={{ width: `${pct}%` }}
                />
                <div className="flex items-center gap-2 min-w-0">
                  <Trash2 className="h-4 w-4 text-amber-600 shrink-0" />
                  <span className="text-sm font-medium text-amber-900 dark:text-amber-100 truncate">
                    Loading #{item.load.id} ({item.load.customerName}) deleted
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-400 text-amber-800 dark:text-amber-200"
                    onClick={() => handleUndo(item)}
                    disabled={restoreMutation.isPending}
                    data-testid={`button-undo-${item.load.id}`}
                  >
                    <Undo2 className="h-3.5 w-3.5 mr-1.5" />
                    Undo
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-amber-700 dark:text-amber-300"
                    onClick={() => dismissUndo(item)}
                    data-testid={`button-dismiss-undo-${item.load.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Pending loadings summary">
        {[
          {
            label: "Pending Loadings",
            value: loads.length.toLocaleString(),
            icon: Truck,
            accent: "text-primary",
            surface: "bg-primary/10",
            border: "border-primary/20",
          },
          {
            label: "Total Bales",
            value: totalBales.toLocaleString(),
            icon: Package,
            accent: "text-primary",
            surface: "bg-primary/10",
            border: "border-primary/20",
          },
          {
            label: "Total Weight",
            value: fmtKg(totalKg),
            icon: Weight,
            accent: "text-primary",
            surface: "bg-primary/10",
            border: "border-primary/20",
          },
          {
            label: "Customers",
            value: customerCount.toLocaleString(),
            icon: Users,
            accent: "text-primary",
            surface: "bg-primary/10",
            border: "border-primary/20",
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className={
              "flex min-w-0 items-center gap-3 rounded-2xl border bg-card px-4 py-3 shadow-sm " + metric.border
            }
          >
            <div className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-xl " + metric.surface}>
              <metric.icon className={"h-5 w-5 " + metric.accent} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xl font-bold tabular-nums tracking-tight text-foreground sm:text-2xl">
                {isLoading ? "—" : metric.value}
              </p>
              <p className="text-xs font-medium text-muted-foreground sm:text-sm">{metric.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-card p-2 shadow-sm sm:gap-3">
        <div className="relative min-w-44 flex-1 sm:max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search customer, loading #, proforma or note..."
            className="h-10 rounded-xl border-border/80 bg-background pl-9"
            aria-label="Search pending loadings"
            data-testid="input-pending-loadings-search"
          />
        </div>
        <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as "newest" | "oldest" | "bales")}>
          <SelectTrigger
            className="h-10 w-full rounded-xl sm:w-52"
            aria-label="Sort pending loadings"
            data-testid="select-pending-loadings-sort"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Started (Newest)</SelectItem>
            <SelectItem value="oldest">Started (Oldest)</SelectItem>
            <SelectItem value="bales">Most Bales</SelectItem>
          </SelectContent>
        </Select>
        <Select value={customerFilter} onValueChange={setCustomerFilter}>
          <SelectTrigger
            className="h-10 w-full rounded-xl sm:w-48"
            aria-label="Filter by customer"
            data-testid="select-pending-loadings-customer"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4 shrink-0" />
            <SelectValue placeholder="All customers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All customers</SelectItem>
            {Array.from(customerNames.entries())
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <SelectItem key={id} value={String(id)}>
                  {name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-xl"
          title="Refresh pending loadings"
          aria-label="Refresh pending loadings"
          onClick={() => queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") })}
          data-testid="button-refresh-pending-loadings"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : loads.length === 0 && undoItems.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-background/70 py-16 text-center text-muted-foreground"
          data-testid="text-no-loads"
        >
          <Truck className="mb-4 h-14 w-14 opacity-30" />
          <p className="text-lg font-semibold">No pending loads</p>
          <p className="mt-1 max-w-md text-sm">All container loadings are either complete or not yet started.</p>
          {canStartLoading && (
            <Button
              className="mt-5 rounded-xl"
              onClick={() => navigate("/factory/sales/loading/new")}
              data-testid="button-start-new"
            >
              <Play className="mr-2 h-4 w-4" />
              Start New Loading
            </Button>
          )}
        </div>
      ) : visibleLoads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-background/70 px-6 py-12 text-center">
          <Search className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" />
          <p className="font-semibold">No matching pending loads</p>
          <p className="mt-1 text-sm text-muted-foreground">Try a different customer or search term.</p>
          <Button
            variant="outline"
            className="mt-4 rounded-xl"
            onClick={() => {
              setCustomerFilter("all");
              setSearchTerm("");
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <FactoryPendingLoadingsListPendingLoadings
          collapsedCustomers={collapsedCustomers}
          groups={groups}
          renderLoadCard={renderLoadCard}
          toggleCustomer={toggleCustomer}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pending loading?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete Loading #{deleteTarget?.id} for <strong>{deleteTarget?.customerName}</strong> and return
              all {deleteTarget?.totalQtyBales} scanned bales back to stock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete & Return to Stock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Link Proforma Dialog */}
      <FactoryPendingLoadingsDialogSection
        closeLinkDialog={closeLinkDialog}
        formatDisplayDate={formatDisplayDate}
        handleConfirmLink={handleConfirmLink}
        linkProformaMutation={linkProformaMutation}
        linkTarget={linkTarget}
        proformas={proformas}
        proformasLoading={proformasLoading}
        selectedProformaId={selectedProformaId}
        setSelectedProformaId={setSelectedProformaId}
      />
    </div>
  );
}
