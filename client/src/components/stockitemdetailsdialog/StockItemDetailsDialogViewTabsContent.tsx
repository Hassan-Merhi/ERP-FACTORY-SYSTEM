// Extracted from ./StockItemDetailsDialogView.tsx
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/formatNumber";
import { Edit, ExternalLink } from "lucide-react";
import { useStockItemDetailsDialogViewState } from "./useStockItemDetailsDialogViewState";

export function StockItemDetailsDialogViewTabsContent({
  allStockItems,
  editedQuantity,
  editedRate,
  editedStockItemId,
  editingTransaction,
  handleCancelTransactionEdit,
  handleEditTransaction,
  handleSaveTransaction,
  loadingTransactions,
  navigate,
  setEditedQuantity,
  setEditedRate,
  setEditedStockItemId,
  transactions,
  updateTransactionMutation,
}: Pick<
  ReturnType<typeof useStockItemDetailsDialogViewState>,
  | "allStockItems"
  | "editedQuantity"
  | "editedRate"
  | "editedStockItemId"
  | "editingTransaction"
  | "handleCancelTransactionEdit"
  | "handleEditTransaction"
  | "handleSaveTransaction"
  | "loadingTransactions"
  | "navigate"
  | "setEditedQuantity"
  | "setEditedRate"
  | "setEditedStockItemId"
  | "transactions"
  | "updateTransactionMutation"
>) {
  return (
    <TabsContent value="transactions" className="space-y-4 mt-4">
      <h3 className="text-lg font-semibold mb-4" data-testid="tab-transactions">
        Voucher History
      </h3>
      {loadingTransactions ? (
        <LoadingState className="py-8" />
      ) : transactions.length === 0 ? (
        <EmptyState title="No transactions found" className="py-8" />
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {transactions.map((transaction) => (
            <Card key={transaction.id} className="p-3">
              {editingTransaction === transaction.id ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Stock Item</Label>
                      <Select
                        value={editedStockItemId?.toString() || ""}
                        onValueChange={(value) => setEditedStockItemId(parseInt(value))}
                      >
                        <SelectTrigger data-testid="select-transaction-item">
                          <SelectValue placeholder="Select item" />
                        </SelectTrigger>
                        <SelectContent>
                          {allStockItems.map((item) => (
                            <SelectItem key={item.id} value={item.id.toString()}>
                              {item.code} - {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Quantity</Label>
                      <Input
                        type="number"
                        step="0.001"
                        value={editedQuantity}
                        onChange={(e) => setEditedQuantity(e.target.value)}
                        data-testid="input-transaction-quantity"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Rate</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={editedRate}
                        onChange={(e) => setEditedRate(e.target.value)}
                        data-testid="input-transaction-rate"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleSaveTransaction(transaction)}
                      disabled={updateTransactionMutation.isPending}
                      data-testid="button-save-transaction"
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCancelTransactionEdit}
                      disabled={updateTransactionMutation.isPending}
                      data-testid="button-cancel-transaction"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-mono font-medium">{transaction.voucherNumber}</p>
                      <span className="text-xs bg-muted px-2 py-1 rounded-sm">{transaction.type}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{transaction.voucherDate}</p>
                    <p className="text-sm mt-1">
                      Qty: {formatNumber(parseFloat(transaction.quantity))} @{" "}
                      {formatNumber(parseFloat(transaction.rate))}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleEditTransaction(transaction)}
                      data-testid={`button-edit-transaction-${transaction.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate(`/vouchers/${transaction.voucherId}`)}
                      data-testid={`button-view-voucher-${transaction.id}`}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </TabsContent>
  );
}
