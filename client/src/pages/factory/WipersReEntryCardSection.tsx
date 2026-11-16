// Extracted from ./WipersReEntry.tsx to keep that module under the source-size cap.
import { Minus, Package, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLabelNum } from "@/lib/labelHtml";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import { useWipersReEntryState } from "./useWipersReEntryState";

export function WipersReEntryCardSection({
  addToCart,
  assignWorker,
  cart,
  entryDate,
  filteredProducts,
  handleKeyDown,
  productsLoading,
  removeItem,
  scanRef,
  searchError,
  searchInput,
  selectedLocationId,
  setConfirmOpen,
  setQtyDirect,
  setSearchError,
  setSearchInput,
  setShowDropdown,
  showDropdown,
  toast,
  totalKg,
  totalQty,
  updateQty,
  updateWeight,
  wiperProducts,
  workers,
}: Pick<
  ReturnType<typeof useWipersReEntryState>,
  | "addToCart"
  | "assignWorker"
  | "cart"
  | "entryDate"
  | "filteredProducts"
  | "handleKeyDown"
  | "productsLoading"
  | "removeItem"
  | "scanRef"
  | "searchError"
  | "searchInput"
  | "selectedLocationId"
  | "setConfirmOpen"
  | "setQtyDirect"
  | "setSearchError"
  | "setSearchInput"
  | "setShowDropdown"
  | "showDropdown"
  | "toast"
  | "totalKg"
  | "totalQty"
  | "updateQty"
  | "updateWeight"
  | "wiperProducts"
  | "workers"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" />
          Wipers Products
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Product search */}
        <div className="relative">
          <Input
            ref={scanRef}
            placeholder="Search wipers / garbage product by name or article code..."
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setShowDropdown(true);
              setSearchError("");
            }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            onKeyDown={handleKeyDown}
            data-testid="input-product-search"
          />
          <MobileBarcodeScanner
            onScan={(code) => {
              const match = wiperProducts.find((product) => productMatchesSearch(product, code));
              if (match) addToCart(match);
              else {
                setSearchInput(code);
                setSearchError(`Unknown product: ${code}`);
              }
            }}
            className="mt-2"
          />
          {searchError && <p className="text-xs text-destructive mt-1">{searchError}</p>}
          {showDropdown && filteredProducts.length > 0 && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-y-auto">
              {filteredProducts.map((p) => (
                <button
                  key={p.id}
                  className="w-full text-left px-3 py-2 text-sm hover-elevate flex items-center justify-between gap-2"
                  onMouseDown={() => addToCart(p)}
                  data-testid={`option-product-${p.id}`}
                >
                  <span>{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.articleCode}</span>
                </button>
              ))}
            </div>
          )}
          {productsLoading && <p className="text-xs text-muted-foreground mt-1">Loading products...</p>}
          {!productsLoading && wiperProducts.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              No wipers/garbage products found. Ensure products are categorized as Wipers or Garbage.
            </p>
          )}
        </div>

        {/* Cart table */}
        {cart.length > 0 ? (
          <div className="table-responsive">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Article Code</TableHead>
                  <TableHead className="w-32 text-right">Qty</TableHead>
                  <TableHead className="w-32 text-right">Weight/Bale (kg)</TableHead>
                  <TableHead className="text-right">Total Weight</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.map((item) => (
                  <TableRow key={item.productId} data-testid={`row-cart-${item.productId}`}>
                    <TableCell className="font-medium">{item.product.name}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {item.product.articleCode || item.product.code}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => updateQty(item.productId, -1)}
                          data-testid={`button-qty-minus-${item.productId}`}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <Input
                          className="w-14 text-center font-mono"
                          value={item.qty}
                          onChange={(e) => setQtyDirect(item.productId, e.target.value)}
                          data-testid={`input-qty-${item.productId}`}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => updateQty(item.productId, 1)}
                          data-testid={`button-qty-plus-${item.productId}`}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        className="w-24 text-right font-mono ml-auto"
                        defaultValue={item.weightPerBaleKg}
                        onBlur={(e) => updateWeight(item.productId, e.target.value)}
                        data-testid={`input-weight-${item.productId}`}
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatLabelNum(item.qty * item.weightPerBaleKg)} kg
                    </TableCell>
                    <TableCell>
                      <Select
                        value={item.finalizedBy?.toString() || "none"}
                        onValueChange={(v) => assignWorker(item.productId, v === "none" ? null : parseInt(v))}
                      >
                        <SelectTrigger className="h-8 w-28" data-testid={`select-worker-${item.productId}`}>
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {workers.map((w) => (
                            <SelectItem key={w.id} value={w.id.toString()}>
                              {w.fullName || w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeItem(item.productId)}
                        data-testid={`button-remove-${item.productId}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground text-sm">
            Search and add wipers / garbage products above
          </div>
        )}

        {/* Cart summary + submit */}
        {cart.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t">
            <div className="flex gap-4 text-sm">
              <span>
                Total bales:{" "}
                <span className="font-semibold font-mono" data-testid="text-total-qty">
                  {totalQty}
                </span>
              </span>
              <span>
                Total weight:{" "}
                <span className="font-semibold font-mono" data-testid="text-total-kg">
                  {formatLabelNum(totalKg)} kg
                </span>
              </span>
            </div>
            <Button
              onClick={() => {
                if (!entryDate) {
                  toast({ title: "Error", description: "Entry date is required", variant: "destructive" });
                  return;
                }
                if (!selectedLocationId) {
                  toast({ title: "Error", description: "Warehouse location is required", variant: "destructive" });
                  return;
                }
                setConfirmOpen(true);
              }}
              data-testid="button-submit"
            >
              Create {totalQty} Bale{totalQty !== 1 ? "s" : ""}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
