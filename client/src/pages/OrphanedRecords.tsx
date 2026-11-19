import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, RefreshCw, AlertTriangle, Archive, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOrphanedRecordsPageModel } from "./OrphanedRecordsPageModel";

export default function OrphanedRecordsPage() {
  const orp = useOrphanedRecordsPageModel();

  return (
    <div className="space-y-4 sm:p-4 md:space-y-6 md:p-6">
      <PageHeader
        title="Orphaned Records"
        subtitle="Records with deleted locations or accounting imbalances"
        icon={<AlertCircle className="h-5 w-5 text-orange-500" />}
      />

      {/* Unbalanced Vouchers Section */}
      <Card className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="h-6 w-6 text-red-500" />
          <div>
            <h2 className="text-lg md:text-xl font-semibold" data-testid="heading-unbalanced-vouchers">
              Unbalanced Vouchers
            </h2>
            <p className="text-sm text-muted-foreground">Vouchers where debits do not equal credits</p>
          </div>
        </div>

        {orp.isLoading ? (
          <LoadingState className="py-8" />
        ) : orp.isError && !orp.recordsData ? (
          <ErrorState onAction={() => void orp.refetch()} actionLabel="Try again" className="py-8" />
        ) : orp.unbalancedRecords.length === 0 ? (
          <div className="text-center py-8">
            <AlertCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <p className="text-lg font-medium text-green-600">All vouchers are balanced</p>
            <p className="text-muted-foreground">No accounting imbalances detected</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block phone-land:hidden">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Voucher #</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total Debits</TableHead>
                    <TableHead className="text-right">Total Credits</TableHead>
                    <TableHead className="text-right">Imbalance</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orp.unbalancedRecords.map((voucher) => (
                    <TableRow key={voucher.id} data-testid={`row-unbalanced-${voucher.id}`}>
                      <TableCell className="font-mono" data-testid={`text-unbalanced-number-${voucher.id}`}>
                        {voucher.voucherNumber}
                      </TableCell>
                      <TableCell data-testid={`text-unbalanced-type-${voucher.id}`}>{voucher.voucherType}</TableCell>
                      <TableCell data-testid={`text-unbalanced-date-${voucher.id}`}>{voucher.voucherDate}</TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-debits-${voucher.id}`}>
                        {orp.formatAmount(voucher.totalDebits)}
                      </TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-credits-${voucher.id}`}>
                        {orp.formatAmount(voucher.totalCredits)}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono text-red-600 font-bold"
                        data-testid={`text-imbalance-${voucher.id}`}
                      >
                        {orp.formatAmount(voucher.imbalance)}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate" data-testid={`text-unbalanced-desc-${voucher.id}`}>
                        {voucher.description || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden phone-land:block space-y-3">
              {orp.unbalancedRecords.map((voucher) => (
                <Card key={voucher.id} className="p-3" data-testid={`card-unbalanced-${voucher.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono text-sm font-medium">{voucher.voucherNumber}</span>
                    <Badge variant="outline">{voucher.voucherType}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{voucher.voucherDate}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Debits</p>
                      <p className="font-mono">{orp.formatAmount(voucher.totalDebits)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Credits</p>
                      <p className="font-mono">{orp.formatAmount(voucher.totalCredits)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Imbalance</p>
                      <p className="font-mono text-red-600 font-bold">{orp.formatAmount(voucher.imbalance)}</p>
                    </div>
                  </div>
                  {voucher.description && (
                    <p className="text-xs text-muted-foreground mt-2 truncate">{voucher.description}</p>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Orphaned Location Vouchers Section */}
      {orp.orphanedRecords.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <Select value={orp.selectedLocation} onValueChange={orp.setSelectedLocation}>
                <SelectTrigger data-testid="select-new-location">
                  <SelectValue placeholder="Select new location" />
                </SelectTrigger>
                <SelectContent>
                  {orp.locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()} data-testid={`option-location-${loc.id}`}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={orp.handleReassign}
              disabled={orp.reassignMutation.isPending || orp.selectedVouchers.length === 0 || !orp.selectedLocation}
              data-testid="button-reassign"
            >
              {orp.reassignMutation.isPending && <RefreshCw className="w-4 h-4 mr-2 animate-spin" />}
              Reassign {orp.selectedVouchers.length} Record{orp.selectedVouchers.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4 md:p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-orange-500" />
            <div>
              <h2 className="text-xl font-semibold">Deleted Location Vouchers</h2>
              <p className="text-sm text-muted-foreground">Vouchers referencing locations that have been deleted</p>
            </div>
          </div>
          {orp.orphanedRecords.length > 0 && (
            <Button
              variant="destructive"
              onClick={() => orp.deleteAllMutation.mutate()}
              disabled={orp.deleteAllMutation.isPending}
              data-testid="button-delete-all-orphaned"
            >
              {orp.deleteAllMutation.isPending && <RefreshCw className="w-4 h-4 mr-2 animate-spin" />}
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All ({orp.orphanedRecords.length})
            </Button>
          )}
        </div>

        {orp.isLoading ? (
          <LoadingState className="py-8" />
        ) : orp.isError && !orp.recordsData ? (
          <ErrorState onAction={() => void orp.refetch()} actionLabel="Try again" className="py-8" />
        ) : orp.orphanedRecords.length === 0 ? (
          <div className="text-center py-8">
            <AlertCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <p className="text-lg font-medium text-green-600">No orphaned records found</p>
            <p className="text-muted-foreground">All your records have valid locations assigned</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block phone-land:hidden">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={
                          orp.selectedVouchers.length === orp.orphanedRecords.length && orp.orphanedRecords.length > 0
                        }
                        onCheckedChange={orp.handleSelectAll}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Voucher #</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Saved Location Name</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orp.orphanedRecords.map((voucher) => (
                    <TableRow key={voucher.id} data-testid={`row-voucher-${voucher.id}`}>
                      <TableCell>
                        <Checkbox
                          checked={orp.selectedVouchers.includes(voucher.id)}
                          onCheckedChange={() => orp.handleToggleVoucher(voucher.id)}
                          data-testid={`checkbox-voucher-${voucher.id}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-voucher-number-${voucher.id}`}>
                        {voucher.voucherNumber}
                      </TableCell>
                      <TableCell data-testid={`text-voucher-type-${voucher.id}`}>{voucher.voucherType}</TableCell>
                      <TableCell data-testid={`text-voucher-date-${voucher.id}`}>{voucher.voucherDate}</TableCell>
                      <TableCell data-testid={`text-location-name-${voucher.id}`}>
                        {voucher.locationName || <span className="text-muted-foreground">Not saved</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-amount-${voucher.id}`}>
                        {orp.formatAmount(voucher.totalAmount)}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate" data-testid={`text-description-${voucher.id}`}>
                        {voucher.description || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden phone-land:block space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Checkbox
                  checked={orp.selectedVouchers.length === orp.orphanedRecords.length && orp.orphanedRecords.length > 0}
                  onCheckedChange={orp.handleSelectAll}
                  data-testid="checkbox-select-all-mobile"
                />
                <span className="text-sm text-muted-foreground">Select All</span>
              </div>
              {orp.orphanedRecords.map((voucher) => (
                <Card key={voucher.id} className="p-3" data-testid={`card-voucher-${voucher.id}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={orp.selectedVouchers.includes(voucher.id)}
                      onCheckedChange={() => orp.handleToggleVoucher(voucher.id)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-medium">{voucher.voucherNumber}</span>
                        <Badge variant="outline">{voucher.voucherType}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{voucher.voucherDate}</p>
                      {voucher.locationName && <p className="text-sm">{voucher.locationName}</p>}
                      <p className="text-sm font-mono text-right mt-1">{orp.formatAmount(voucher.totalAmount)}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Archived Stock Groups Section */}
      <Card className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <Archive className="h-6 w-6 text-blue-500" />
          <div>
            <h2 className="text-xl font-semibold" data-testid="heading-archived-stock-groups">
              Archived Stock Groups
            </h2>
            <p className="text-sm text-muted-foreground">
              Stock groups that have been cleared from locations (can be restored or permanently deleted)
            </p>
          </div>
        </div>

        {orp.archivesLoading ? (
          <LoadingState className="py-8" />
        ) : orp.archivesError && orp.stockGroupArchives.length === 0 ? (
          <ErrorState onAction={() => void orp.refetchArchives()} actionLabel="Try again" className="py-8" />
        ) : orp.stockGroupArchives.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="No archived stock groups"
            description="Archive stock groups from Location Inventory to clear and backup inventory data"
            className="py-8"
          />
        ) : (
          <>
            <div className="hidden md:block phone-land:hidden">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Stock Group</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Total Qty</TableHead>
                    <TableHead className="text-right">Total Value</TableHead>
                    <TableHead>Archived Date</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orp.stockGroupArchives.map((archive) => (
                    <TableRow key={archive.id} data-testid={`row-archive-${archive.id}`}>
                      <TableCell className="font-medium" data-testid={`text-archive-group-${archive.id}`}>
                        {archive.stockGroupName}
                      </TableCell>
                      <TableCell data-testid={`text-archive-location-${archive.id}`}>{archive.locationName}</TableCell>
                      <TableCell className="text-right" data-testid={`text-archive-items-${archive.id}`}>
                        {archive.itemCount}
                      </TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-archive-qty-${archive.id}`}>
                        {parseFloat(archive.totalQuantity).toFixed(3)}
                      </TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-archive-value-${archive.id}`}>
                        {orp.formatAmount(archive.totalValue)}
                      </TableCell>
                      <TableCell data-testid={`text-archive-date-${archive.id}`}>
                        {orp.formatDisplayDate(archive.archivedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => orp.restoreArchiveMutation.mutate(archive.id)}
                            disabled={orp.restoreArchiveMutation.isPending}
                            data-testid={`button-restore-archive-${archive.id}`}
                          >
                            <RotateCcw className="h-4 w-4 mr-1" />
                            Restore
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => orp.deleteArchiveMutation.mutate({ archiveId: archive.id, permanent: true })}
                            disabled={orp.deleteArchiveMutation.isPending}
                            data-testid={`button-delete-archive-${archive.id}`}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden phone-land:block space-y-3">
              {orp.stockGroupArchives.map((archive) => (
                <Card key={archive.id} className="p-3" data-testid={`card-archive-${archive.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-medium text-sm">{archive.stockGroupName}</span>
                    <span className="text-sm text-muted-foreground">{archive.locationName}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm mb-2">
                    <div>
                      <p className="text-xs text-muted-foreground">Items</p>
                      <p>{archive.itemCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Qty</p>
                      <p className="font-mono">{parseFloat(archive.totalQuantity).toFixed(3)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Value</p>
                      <p className="font-mono">{orp.formatAmount(archive.totalValue)}</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{orp.formatDisplayDate(archive.archivedAt)}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => orp.restoreArchiveMutation.mutate(archive.id)}
                      disabled={orp.restoreArchiveMutation.isPending}
                    >
                      <RotateCcw className="h-4 w-4 mr-1" />
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => orp.deleteArchiveMutation.mutate({ archiveId: archive.id, permanent: true })}
                      disabled={orp.deleteArchiveMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card className="p-4 bg-muted/50">
        <h3 className="font-semibold mb-2">How this works:</h3>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>
            <strong>Unbalanced Vouchers:</strong> These have accounting errors where debits don't equal credits. Review
            and fix manually in the voucher editor.
          </li>
          <li>
            <strong>Deleted Location Vouchers:</strong> These reference locations that have been deleted. Select records
            and reassign to a valid location.
          </li>
          <li>
            <strong>Archived Stock Groups:</strong> Stock groups that have been cleared from a location. Restore to
            recover the inventory, or permanently delete after re-importing.
          </li>
          <li>The location name is saved on vouchers to preserve history if the location is deleted in the future.</li>
        </ul>
      </Card>
    </div>
  );
}
