import { Search, ShoppingCart, Trash2, MapPin, User, ChevronDown, Check, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { AuthMe } from "@shared/apiTypes";
import type {
  BankAccountRow,
  InventoryItem,
  LedgerPickerAccount,
  Location,
  PosMutationPending,
  SaleRow,
} from "./posTypes";
import { getFilteredInventory } from "../utils/posCalculations";

interface PosMobileLayoutProps {
  posUser?: AuthMe | null;
  activeLocation: Location | null;
  allLocations: Location[];
  posAssignedLocations: Location[];
  posSelectedLocation: Location | null;
  setPosSelectedLocation: (loc: Location) => void;
  setSelectedLocation: (loc: Location) => void;
  saleDate: string;
  setSaleDate: (date: string) => void;
  paymentAccountType: string;
  setPaymentAccountType: (type: "bank" | "cash") => void;
  paymentAccountId: string | null;
  setPaymentAccountId: (id: string) => void;
  bankAccounts: BankAccountRow[];
  cashLedgerAccounts: LedgerPickerAccount[];
  isCreditSale: boolean;
  setIsCreditSale: (v: boolean) => void;
  mobileCustomerComboOpen: boolean;
  setMobileCustomerComboOpen: (v: boolean) => void;
  selectedCustomerId: string;
  setSelectedCustomerId: (id: string) => void;
  customerAccounts: LedgerPickerAccount[];
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  mobileSearchInputRef: React.RefObject<HTMLInputElement | null>;
  inventory: InventoryItem[];
  selectItem: (item: InventoryItem) => void;
  rows: SaleRow[];
  setRows: React.Dispatch<React.SetStateAction<SaleRow[]>>;
  updateRow: (index: number, field: keyof SaleRow, value: string | number) => void;
  notes: string;
  setNotes: (v: string) => void;
  saveMutation: PosMutationPending;
  hasValidItems: boolean;
  disableSave?: boolean;
  handleSaveSale: () => void;
  formatDisplayAmount: (v: number) => string;
  isSpCompany?: boolean;
}

export function PosMobileLayout({
  posUser,
  activeLocation,
  allLocations,
  posAssignedLocations,
  posSelectedLocation,
  setPosSelectedLocation,
  setSelectedLocation,
  saleDate,
  setSaleDate,
  paymentAccountType,
  setPaymentAccountType,
  paymentAccountId,
  setPaymentAccountId,
  bankAccounts,
  cashLedgerAccounts,
  isCreditSale,
  setIsCreditSale,
  mobileCustomerComboOpen,
  setMobileCustomerComboOpen,
  selectedCustomerId,
  setSelectedCustomerId,
  customerAccounts,
  searchTerm,
  setSearchTerm,
  mobileSearchInputRef,
  inventory,
  selectItem,
  rows,
  setRows,
  updateRow,
  notes,
  setNotes,
  saveMutation,
  hasValidItems,
  disableSave,
  handleSaveSale,
  formatDisplayAmount,
  isSpCompany,
}: PosMobileLayoutProps) {
  const filteredInventory = getFilteredInventory(inventory, searchTerm).slice(0, 60);
  const validRows = rows.filter((row) => row.stockItemId && row.quantity > 0);
  const total = validRows.reduce((sum, row) => sum + row.amount, 0);
  const quantity = validRows.reduce((sum, row) => sum + row.quantity, 0);
  const resultsId = "pos-mobile-product-results";

  return (
    <div
      data-pos-mobile-page="true"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain pb-[calc(7.5rem+env(safe-area-inset-bottom))] lg:hidden"
    >
      <section
        className="sticky top-0 z-30 border-b bg-background/95 px-3 pb-3 pt-3 shadow-sm backdrop-blur sm:px-4"
        aria-label="Product search"
      >
        <label htmlFor="pos-mobile-product-search" className="mb-2 block text-sm font-semibold">
          Add an item
        </label>
        <div className="relative">
          <div className="flex min-h-12 items-center gap-2 rounded-xl border-2 border-input bg-background px-3 transition-all focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              id="pos-mobile-product-search"
              ref={mobileSearchInputRef as React.RefObject<HTMLInputElement>}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={Boolean(searchTerm && filteredInventory.length)}
              aria-controls={resultsId}
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="search"
              className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              placeholder="Scan code or type product name…"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              data-testid="input-mobile-product-search"
            />
            {searchTerm && (
              <button
                type="button"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-muted-foreground hover:bg-muted"
                onClick={() => setSearchTerm("")}
                aria-label="Clear product search"
              >
                ×
              </button>
            )}
          </div>

          {searchTerm && filteredInventory.length > 0 && (
            <div
              id={resultsId}
              role="listbox"
              aria-label="Matching stock items"
              className="absolute inset-x-0 top-full z-40 mt-2 max-h-[min(22rem,48dvh)] overflow-y-auto overscroll-contain rounded-xl border bg-background shadow-xl"
            >
              {filteredInventory.map((item) => {
                const isOut = item.stock === 0;
                const isLow = !isOut && item.stock < 10;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    key={item.stockItemId ?? item.code}
                    className="flex min-h-14 w-full items-center justify-between gap-3 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 active:bg-primary/10 sm:px-4"
                    onClick={() => {
                      selectItem(item);
                      setSearchTerm("");
                    }}
                    data-testid={`button-mobile-select-item-${item.stockItemId ?? item.code}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-semibold leading-snug sm:text-base">
                        {item.name}
                      </span>
                      <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
                        {item.code}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold tabular-nums ${
                        isOut
                          ? "bg-red-500/15 text-red-600 dark:text-red-400"
                          : isLow
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {isOut
                        ? "Out"
                        : isLow
                          ? `${Math.round(item.stock)} low`
                          : Math.round(item.stock).toLocaleString()}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="border-b bg-muted/10 px-3 py-3 sm:px-4" aria-label="Sale settings">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {!posUser ? (
            <Select
              value={activeLocation?.id?.toString()}
              onValueChange={(value) => {
                const location = allLocations.find((candidate) => candidate.id.toString() === value);
                if (location) setSelectedLocation(location);
              }}
            >
              <SelectTrigger className="min-h-11 w-full min-w-0" data-testid="select-mobile-location">
                <MapPin className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Location" />
              </SelectTrigger>
              <SelectContent>
                {allLocations.map((location) => (
                  <SelectItem key={location.id} value={location.id.toString()}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : posAssignedLocations.length > 1 ? (
            <Select
              value={posSelectedLocation?.id?.toString()}
              onValueChange={(value) => {
                const location = posAssignedLocations.find((candidate) => candidate.id.toString() === value);
                if (location) setPosSelectedLocation(location);
              }}
            >
              <SelectTrigger className="min-h-11 w-full min-w-0" data-testid="select-mobile-pos-location">
                <MapPin className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Location" />
              </SelectTrigger>
              <SelectContent>
                {posAssignedLocations.map((location) => (
                  <SelectItem key={location.id} value={location.id.toString()}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm">
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{activeLocation?.name}</span>
            </div>
          )}

          <input
            type="date"
            value={saleDate}
            onChange={posUser ? undefined : (event) => setSaleDate(event.target.value)}
            readOnly={Boolean(posUser)}
            aria-label="Sale date"
            className={`min-h-11 min-w-0 rounded-lg border border-input bg-background px-3 text-base font-mono outline-none focus:ring-2 focus:ring-ring ${
              posUser ? "cursor-not-allowed opacity-60" : ""
            }`}
            data-testid="input-mobile-sale-date"
          />
        </div>

        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {!isSpCompany && (
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-background px-3">
              <Label htmlFor="mobile-credit-sale" className="cursor-pointer text-sm font-medium">
                Credit sale
              </Label>
              <Switch
                id="mobile-credit-sale"
                checked={isCreditSale}
                onCheckedChange={setIsCreditSale}
                data-testid="toggle-mobile-credit-sale"
              />
            </div>
          )}

          {!isSpCompany && isCreditSale ? (
            <Popover open={mobileCustomerComboOpen} onOpenChange={setMobileCustomerComboOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="min-h-11 w-full min-w-0 justify-start gap-2 font-normal"
                  data-testid="select-mobile-customer"
                >
                  <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedCustomerId
                      ? customerAccounts.find((account) => String(account.id) === selectedCustomerId)?.name ||
                        "Customer"
                      : "Select customer…"}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(22rem,calc(100vw-1rem))] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search customer…" />
                  <CommandList>
                    <CommandEmpty>No customer found.</CommandEmpty>
                    <CommandGroup>
                      {customerAccounts.map((account) => (
                        <CommandItem
                          key={account.id}
                          value={account.name ?? ""}
                          onSelect={() => {
                            setSelectedCustomerId(String(account.id));
                            setMobileCustomerComboOpen(false);
                          }}
                        >
                          <Check
                            className={`mr-2 h-4 w-4 shrink-0 ${
                              selectedCustomerId === String(account.id) ? "opacity-100" : "opacity-0"
                            }`}
                          />
                          {account.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : (
            <div className={`grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-2 ${isSpCompany ? "sm:col-span-2" : ""}`}>
              <Select
                value={paymentAccountType}
                onValueChange={posUser ? undefined : (value: "bank" | "cash") => setPaymentAccountType(value)}
                disabled={Boolean(posUser)}
              >
                <SelectTrigger className="min-h-11 w-full" data-testid="select-mobile-account-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={paymentAccountId || ""}
                onValueChange={posUser ? undefined : setPaymentAccountId}
                disabled={Boolean(posUser)}
              >
                <SelectTrigger className="min-h-11 w-full min-w-0" data-testid="select-mobile-payment-account">
                  <SelectValue placeholder={paymentAccountType === "bank" ? "Select Bank" : "Select Cash"} />
                </SelectTrigger>
                <SelectContent>
                  {paymentAccountType === "bank"
                    ? (Array.isArray(bankAccounts) ? bankAccounts : []).map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>
                          {account.name} ({account.code})
                        </SelectItem>
                      ))
                    : cashLedgerAccounts.map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>
                          {account.name}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </section>

      <section className="min-w-0 space-y-3 px-3 py-4 sm:px-4" aria-labelledby="pos-mobile-cart-title">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="pos-mobile-cart-title" className="text-base font-semibold">
              Current sale
            </h2>
            <p className="text-xs text-muted-foreground">
              {validRows.length} {validRows.length === 1 ? "item" : "items"} · Qty {quantity.toFixed(0)}
            </p>
          </div>
          <ShoppingCart className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>

        {validRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-14 text-center text-muted-foreground">
            <ShoppingCart className="h-12 w-12 opacity-30" />
            <p className="text-sm">Search above to add items.</p>
          </div>
        ) : (
          validRows.map((row) => {
            const actualIndex = rows.indexOf(row);
            return (
              <Card key={row.id} className="min-w-0 p-3 shadow-sm sm:p-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold leading-snug sm:text-base">{row.itemName}</p>
                    <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{row.stockItemCode}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setRows((current) => current.filter((_, index) => index !== actualIndex))}
                    className="h-11 w-11 shrink-0 text-destructive hover:text-destructive"
                    aria-label={`Remove ${row.itemName}`}
                    data-testid={`button-mobile-delete-${actualIndex}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`input-mobile-qty-${actualIndex}`} className="text-xs text-muted-foreground">
                      Quantity
                    </Label>
                    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-11 w-11"
                        onClick={() =>
                          updateRow(actualIndex, "quantity", String(Math.max(0, Number(row.quantity || 0) - 1)))
                        }
                        aria-label={`Decrease quantity for ${row.itemName}`}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <input
                        id={`input-mobile-qty-${actualIndex}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        value={row.quantity || ""}
                        onChange={(event) => updateRow(actualIndex, "quantity", event.target.value)}
                        className="h-11 min-w-0 rounded-lg border border-input bg-background text-center text-base font-semibold tabular-nums outline-none focus:ring-2 focus:ring-ring"
                        data-testid={`input-mobile-qty-${actualIndex}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-11 w-11"
                        onClick={() => updateRow(actualIndex, "quantity", String(Number(row.quantity || 0) + 1))}
                        aria-label={`Increase quantity for ${row.itemName}`}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid min-w-0 grid-cols-2 gap-3">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`input-mobile-rate-${actualIndex}`} className="text-xs text-muted-foreground">
                        Rate
                      </Label>
                      <input
                        id={`input-mobile-rate-${actualIndex}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        value={row.rate || ""}
                        onChange={(event) => updateRow(actualIndex, "rate", event.target.value)}
                        className="h-11 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-right text-base font-mono tabular-nums outline-none focus:ring-2 focus:ring-ring"
                        data-testid={`input-mobile-rate-${actualIndex}`}
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <span className="block text-xs text-muted-foreground">Total</span>
                      <div className="flex h-11 min-w-0 items-center justify-end rounded-lg bg-muted/50 px-2 font-mono text-base font-bold tabular-nums">
                        <span className="truncate">{formatDisplayAmount(row.amount)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </section>

      <section className="px-3 pb-4 sm:px-4" aria-label="Sale notes">
        <Label htmlFor="input-mobile-notes" className="mb-1.5 block text-xs text-muted-foreground">
          Notes
        </Label>
        <Textarea
          id="input-mobile-notes"
          placeholder="Optional notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="min-h-24 resize-y text-base"
          data-testid="input-mobile-notes"
        />
      </section>

      <div
        data-pos-mobile-checkout="true"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {validRows.length} {validRows.length === 1 ? "item" : "items"} · Qty {quantity.toFixed(0)}
            </p>
            <p className="truncate font-mono text-xl font-bold tabular-nums sm:text-2xl">
              {formatDisplayAmount(total)}
            </p>
          </div>
          <Button
            className="min-h-12 min-w-[8.5rem] shrink-0 px-5 text-base font-semibold"
            size="lg"
            onClick={handleSaveSale}
            disabled={saveMutation?.isPending || !hasValidItems || disableSave}
            data-testid="button-mobile-checkout"
          >
            {saveMutation?.isPending ? "Saving…" : "Checkout"}
          </Button>
        </div>
      </div>
    </div>
  );
}
