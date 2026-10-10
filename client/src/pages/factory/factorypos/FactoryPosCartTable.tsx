/**
 * Desktop Factory POS cart grid and its totals block (summary, expense
 * deductions and the credit-sale balance preview).
 *
 * Split out of FactoryPOS.tsx unchanged: same COLUMNS layout, same read-only
 * behaviour on the trailing empty row, same deduction arithmetic and the same
 * previous-balance/after-sale calculation for credit customers.
 */
import { Plus, Trash2, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COLUMNS, formatNum } from "./utils";
import type { FactoryPosModel } from "./useFactoryPosModel";

function CreditSaleSummary({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, total } = model;
  const custObj = (model.allCustomers || []).find((c) => String(c.id) === model.selectedCustomerId);
  const prevBal = custObj ? parseFloat(custObj.balance || "0") : 0;
  const prevBalSide = custObj?.balanceSide || "Dr";
  const prevNet = prevBalSide === "Dr" ? prevBal : -prevBal;
  const afterSale = prevNet + total;
  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-3 space-y-1.5 text-sm" data-testid="credit-sale-summary">
      <div className="flex items-center gap-1.5 font-medium text-xs text-muted-foreground uppercase tracking-wide mb-1">
        <CreditCard className="h-3.5 w-3.5" />
        Credit Sale Summary
      </div>
      {custObj && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">Previous balance</span>
          <span className="font-mono">
            {prevNet >= 0 ? "Dr " : "Cr "}
            {ccPrefix}
            {formatNum(Math.abs(prevNet))}
          </span>
        </div>
      )}
      <div className="flex justify-between">
        <span className="text-muted-foreground">This sale (Dr)</span>
        <span className="font-mono">
          +{ccPrefix}
          {formatNum(total)}
        </span>
      </div>
      <div className="flex justify-between font-semibold border-t border-border pt-1.5">
        <span>Balance after sale</span>
        <span className="font-mono" data-testid="text-balance-after-sale">
          {afterSale >= 0 ? "Dr " : "Cr "}
          {ccPrefix}
          {formatNum(Math.abs(afterSale))}
        </span>
      </div>
    </div>
  );
}

function ExpenseDeductions({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, totalExpenseAmount, netTotal } = model;
  return (
    <div className="sm:max-w-lg ml-auto space-y-2">
      {model.expenseRows.map((exp, idx) => (
        <div key={exp.id} className="flex gap-2 items-center">
          <Select value={exp.accountId} onValueChange={(v) => model.updateExpenseRow(idx, "accountId", v)}>
            <SelectTrigger className="flex-1 min-w-0" data-testid={`select-expense-account-${idx}`}>
              <SelectValue placeholder="Expense account" />
            </SelectTrigger>
            <SelectContent>
              {(model.ledgerAccounts || []).map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Description"
            value={exp.description}
            onChange={(e) => model.updateExpenseRow(idx, "description", e.target.value)}
            className="w-28 shrink-0"
            data-testid={`input-expense-description-${idx}`}
          />
          <Input
            type="number"
            inputMode="decimal"
            placeholder="Amount"
            value={exp.amount}
            onChange={(e) => model.updateExpenseRow(idx, "amount", e.target.value)}
            className="w-24 shrink-0 text-right font-mono"
            data-testid={`input-expense-amount-${idx}`}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => model.removeExpenseRow(idx)}
            data-testid={`button-remove-expense-${idx}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={model.addExpenseRow}
          className="text-muted-foreground"
          data-testid="button-add-deduction"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Deduction
        </Button>
        {totalExpenseAmount > 0 && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Deductions:</span>
              <span className="font-mono text-destructive">
                -{ccPrefix}
                {formatNum(totalExpenseAmount)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-base font-medium">Net Cash:</span>
              <span className="text-xl font-semibold font-mono" data-testid="text-net-total">
                {ccPrefix}
                {formatNum(netTotal)}
              </span>
            </div>
          </div>
        )}
        {model.paymentType === "CREDIT" && <CreditSaleSummary model={model} />}
      </div>
    </div>
  );
}

function CartRows({ model }: { model: FactoryPosModel }) {
  const { ccPrefix } = model;
  return (
    <div className="max-h-[calc(100vh-24rem)] overflow-y-auto">
      {model.rows.map((row, idx) => (
        <div key={row.id} className="flex border-b border-muted/50 hover-elevate">
          <div className="w-10 flex items-center justify-center border-r border-muted/50 h-10 text-xs text-muted-foreground">
            {row.productId ? idx + 1 : ""}
          </div>
          {COLUMNS.map((col) => (
            <div key={col.key} className={`${col.width} border-r h-10 ${col.key === "amount" ? "bg-muted/30" : ""}`}>
              {col.key === "delete" ? (
                row.productId ? (
                  <div className="flex items-center justify-center h-full">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => model.deleteRow(idx)}
                      data-testid={`button-delete-row-${idx}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ) : null
              ) : col.key === "amount" ? (
                <div className="flex items-center justify-end h-full px-3 font-mono text-sm text-muted-foreground">
                  {row.productId ? `${ccPrefix}${formatNum(row.quantity * row.unitPrice)}` : ""}
                </div>
              ) : col.key === "productName" ? (
                <div className="flex items-center h-full px-3 text-sm font-medium">
                  {row.productId ? (
                    <div className="min-w-0">
                      <div className="truncate">{row.productName}</div>
                      {row.articleCode && (
                        <div className="text-xs text-muted-foreground truncate">{row.articleCode}</div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground/50 text-xs">Click a product →</span>
                  )}
                </div>
              ) : (
                <input
                  ref={(el) => {
                    model.inputRefs.current[`${idx}-${col.key}`] = el;
                  }}
                  type="number"
                  inputMode="decimal"
                  value={!row.productId ? "" : col.key === "quantity" ? row.quantity : row.unitPrice}
                  onChange={(e) =>
                    row.productId && model.updateRow(idx, col.key as "quantity" | "unitPrice", e.target.value)
                  }
                  readOnly={!row.productId}
                  className={`w-full h-full px-3 bg-transparent outline-none focus:bg-accent/20 text-sm font-mono text-right ${!row.productId ? "cursor-default" : ""}`}
                  data-testid={`input-${col.key}-${idx}`}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function FactoryPosCartTable({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, validRows, totalQty, totalWeight, total } = model;
  return (
    <>
      <div className="table-responsive">
        <div className="min-w-[400px]">
          {/* Header */}
          <div className="flex bg-muted/30 border-b border-muted sticky top-0 z-30">
            <div className="w-10 flex items-center justify-center border-r border-muted h-10 text-xs text-muted-foreground">
              #
            </div>
            {COLUMNS.map((col) => (
              <div
                key={col.key}
                className={`${col.width} flex items-center px-3 border-r border-muted h-10 text-xs text-muted-foreground`}
              >
                {col.label}
              </div>
            ))}
          </div>

          {/* Rows */}
          <CartRows model={model} />
        </div>
      </div>

      {/* Total Section */}
      <div className="border-t border-muted bg-muted/20 p-4 space-y-3">
        {/* Summary row */}
        <div className="flex flex-col sm:flex-row sm:justify-end items-stretch sm:items-center gap-2 sm:gap-6 sm:max-w-lg ml-auto">
          <div className="flex items-center justify-between sm:justify-start gap-2 text-sm flex-wrap">
            <span className="text-muted-foreground">Items:</span>
            <span className="font-mono">{validRows.length}</span>
            <span className="text-muted-foreground ml-2">Qty:</span>
            <span className="font-mono" data-testid="text-total-qty">
              {totalQty}
            </span>
            {totalWeight > 0 && (
              <>
                <span className="text-muted-foreground ml-2">Wt:</span>
                <span className="font-mono" data-testid="text-total-weight">
                  {formatNum(totalWeight)} kg
                </span>
              </>
            )}
          </div>
          <div className="flex items-center justify-between sm:justify-start gap-2">
            <span className="text-lg font-medium">Total:</span>
            <span className="text-2xl font-semibold font-mono" data-testid="text-grand-total">
              {ccPrefix}
              {formatNum(total)}
            </span>
          </div>
        </div>

        {/* Expense deductions */}
        <ExpenseDeductions model={model} />
      </div>
    </>
  );
}
