// Extracted from ./FactoryEmployeeDetail.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fmt } from "./FactoryEmployeeDetailTypes";
import { useFactoryEmployeeDetailState } from "./useFactoryEmployeeDetailState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export function FactoryEmployeeDetailSection({
  stmtError,
  refetchStatement,
  formatDate,
  statement,
  stmtLoading,
}: Pick<
  ReturnType<typeof useFactoryEmployeeDetailState>,
  "formatDate" | "statement" | "stmtLoading" | "refetchStatement" | "stmtError"
>) {
  return (
    <div className="flex-1 min-w-0">
      <Card>
        <CardHeader className="pb-2 pt-4 px-5">
          <CardTitle className="text-sm text-muted-foreground">Running Statement</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-4 overflow-x-auto">
          {stmtLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : stmtError && !statement ? (
            <ErrorState onAction={() => void refetchStatement()} actionLabel="Try again" />
          ) : !statement?.rows || statement.rows.length === 0 ? (
            <EmptyState title="No transactions yet" />
          ) : (
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Deposit</TableHead>
                  <TableHead className="text-right">Withdrawal</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.rows.map((row) => (
                  <TableRow key={row.id} data-testid={`row-stmt-${row.id}`}>
                    <TableCell className="text-sm">{formatDate(row.voucherDate)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.voucherNumber}</TableCell>
                    <TableCell className="text-sm" dir="ltr">
                      {row.narration || row.description || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {row.credit > 0 ? (
                        <span className="text-green-600 dark:text-green-400">{fmt(row.credit)}</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {row.debit > 0 ? <span className="text-red-600 dark:text-red-400">{fmt(row.debit)}</span> : "—"}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono text-sm font-semibold ${row.balance < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                    >
                      {fmt(row.balance)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function FactoryEmployeeDetailDialogSection({
  editForm,
  editOpen,
  setEditForm,
  setEditOpen,
  updateMutation,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useFactoryEmployeeDetailState>,
  "editForm" | "editOpen" | "setEditForm" | "setEditOpen" | "updateMutation" | "wrapAdminAction"
>) {
  return (
    <Dialog open={editOpen} onOpenChange={setEditOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Employee</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input
                value={editForm.firstName}
                onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                data-testid="input-edit-first-name"
              />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input
                value={editForm.lastName}
                onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                data-testid="input-edit-last-name"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Department</Label>
            <Input
              value={editForm.department}
              onChange={(e) => setEditForm((f) => ({ ...f, department: e.target.value }))}
              data-testid="input-edit-department"
            />
          </div>
          <div className="space-y-1">
            <Label>Phone</Label>
            <Input
              value={editForm.phone}
              onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
              data-testid="input-edit-phone"
            />
          </div>
          <div className="space-y-1">
            <Label>Monthly Salary</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={editForm.monthlySalary}
              onChange={(e) => setEditForm((f) => ({ ...f, monthlySalary: e.target.value }))}
              data-testid="input-edit-salary"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => wrapAdminAction(() => updateMutation.mutate(editForm), "Save Employee")}
            disabled={updateMutation.isPending}
            data-testid="button-save-edit"
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
