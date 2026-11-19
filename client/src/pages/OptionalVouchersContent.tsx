// Extracted from ./OptionalVouchers.tsx
import { ErpListTable, ErpRecordAction } from "@/erp-core";
import { TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Pencil, Check, Trash2, Eye } from "lucide-react";
import { OptionalVouchersTableBodySection, useOptionalVouchersState } from "./useOptionalVouchersState";

export function OptionalVouchersContent({
  formatShortDate,
  getTypeBadgeVariant,
  grandTotal,
  handleEdit,
  orderedVouchers,
  selectedCompany,
  setDeleteVoucherId,
  setFinalizeVoucherId,
  setViewVoucher,
  vouchers,
}: Pick<
  ReturnType<typeof useOptionalVouchersState>,
  | "formatShortDate"
  | "getTypeBadgeVariant"
  | "grandTotal"
  | "handleEdit"
  | "orderedVouchers"
  | "selectedCompany"
  | "setDeleteVoucherId"
  | "setFinalizeVoucherId"
  | "setViewVoucher"
  | "vouchers"
>) {
  return (
    <>
      {/* Desktop table */}
      <ErpListTable
        pageKey="optional-vouchers"
        companyId={selectedCompany?.id}
        scrollLabel="Optional vouchers"
        wrapperClassName="hidden md:block phone-land:hidden rounded-xl"
      >
        <TableHeader className="sticky top-0 z-30 bg-muted">
          <TableRow className="h-11 bg-muted/40 border-b">
            <TableHead className="text-left px-4 font-medium">Date</TableHead>
            <TableHead className="text-left px-4 font-medium">Type</TableHead>
            <TableHead className="text-left px-4 font-medium">Description</TableHead>
            <TableHead className="text-right px-4 font-medium">Total</TableHead>
            <TableHead className="text-right px-4 font-medium">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <OptionalVouchersTableBodySection
          formatShortDate={formatShortDate}
          getTypeBadgeVariant={getTypeBadgeVariant}
          handleEdit={handleEdit}
          orderedVouchers={orderedVouchers}
          setDeleteVoucherId={setDeleteVoucherId}
          setFinalizeVoucherId={setFinalizeVoucherId}
          setViewVoucher={setViewVoucher}
        />
        <TableFooter>
          <TableRow className="border-t bg-muted/40">
            <TableCell colSpan={3} className="px-4 py-2 text-sm font-medium">
              Total ({vouchers.length} voucher{vouchers.length !== 1 ? "s" : ""})
            </TableCell>
            <TableCell
              className="px-4 py-2 text-right tabular-nums font-semibold"
              data-testid="text-optional-grand-total-footer"
            >
              {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </ErpListTable>

      {/* Mobile cards */}
      <div className="md:hidden phone-land:block space-y-2">
        {orderedVouchers.map((v) => (
          <div key={v.id} className="border rounded-xl p-4 space-y-2" data-testid={`card-voucher-${v.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{v.voucherDate ? formatShortDate(v.voucherDate) : "—"}</div>
                {v.description && <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>}
              </div>
              <Badge variant={getTypeBadgeVariant(v.voucherType)} className="text-xs shrink-0">
                {v.voucherType}
              </Badge>
            </div>
            <div className="flex items-center justify-end text-sm">
              <span className="font-semibold tabular-nums">
                {parseFloat(v.totalAmount || "0").toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <div className="flex items-center gap-1 pt-1 border-t">
              <ErpRecordAction
                size="icon"
                variant="ghost"
                onClick={() => setViewVoucher(v)}
                data-testid={`button-view-mobile-${v.id}`}
                className="h-8 w-8"
                title="View voucher details"
                aria-label="View voucher details"
              >
                <Eye className="h-3.5 w-3.5" />
              </ErpRecordAction>
              <ErpRecordAction
                size="sm"
                variant="ghost"
                onClick={() => handleEdit(v)}
                data-testid={`button-edit-mobile-${v.id}`}
                className="gap-1.5 flex-1 h-8"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </ErpRecordAction>
              <ErpRecordAction
                size="sm"
                variant="ghost"
                onClick={() => setFinalizeVoucherId(v.id)}
                data-testid={`button-finalize-mobile-${v.id}`}
                className="gap-1.5 flex-1 h-8 text-green-700 dark:text-green-400"
              >
                <Check className="h-3.5 w-3.5" />
                Finalize
              </ErpRecordAction>
              <ErpRecordAction
                size="icon"
                variant="ghost"
                onClick={() => setDeleteVoucherId(v.id)}
                data-testid={`button-delete-mobile-${v.id}`}
                className="h-8 w-8 text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </ErpRecordAction>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
