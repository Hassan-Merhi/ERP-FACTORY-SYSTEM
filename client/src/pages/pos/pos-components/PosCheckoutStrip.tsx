import { MapPin, User, ChevronDown, Check } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { AuthMe } from "@shared/apiTypes";
import type { BankAccountRow, LedgerPickerAccount, Location } from "./posTypes";

interface PosCheckoutStripProps {
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
  isCreditSale: boolean;
  setIsCreditSale: (v: boolean) => void;
  customerComboOpen: boolean;
  setCustomerComboOpen: (v: boolean) => void;
  selectedCustomerId: string;
  setSelectedCustomerId: (id: string) => void;
  customerAccounts: LedgerPickerAccount[];
  bankAccounts: BankAccountRow[];
  cashLedgerAccounts: LedgerPickerAccount[];
  /** Supplier Partner sales support cash/bank settlement like normal ERP POS — no credit option. */
  isSpCompany?: boolean;
}

export function PosCheckoutStrip({
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
  isCreditSale,
  setIsCreditSale,
  customerComboOpen,
  setCustomerComboOpen,
  selectedCustomerId,
  setSelectedCustomerId,
  customerAccounts,
  bankAccounts,
  cashLedgerAccounts,
  isSpCompany,
}: PosCheckoutStripProps) {
  if (!activeLocation) return null;

  return (
    <div className="hidden lg:flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-muted/10">
      {/* Location — admin: full select; POS user: name badge or select if multiple */}
      {!posUser ? (
        <Select
          value={activeLocation?.id?.toString()}
          onValueChange={(val) => {
            const loc = allLocations.find((l) => l.id.toString() === val);
            if (loc) setSelectedLocation(loc);
          }}
        >
          <SelectTrigger className="w-[180px]" data-testid="select-admin-location">
            <MapPin className="h-3.5 w-3.5 mr-1 text-muted-foreground shrink-0" />
            <SelectValue placeholder="Location" />
          </SelectTrigger>
          <SelectContent>
            {allLocations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id.toString()}>
                {loc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : posAssignedLocations.length > 1 ? (
        <Select
          value={posSelectedLocation?.id?.toString()}
          onValueChange={(val) => {
            const loc = posAssignedLocations.find((l) => l.id.toString() === val);
            if (loc) setPosSelectedLocation(loc);
          }}
        >
          <SelectTrigger className="w-[180px]" data-testid="select-pos-location-strip">
            <MapPin className="h-3.5 w-3.5 mr-1 text-muted-foreground shrink-0" />
            <SelectValue placeholder="Location" />
          </SelectTrigger>
          <SelectContent>
            {posAssignedLocations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id.toString()}>
                {loc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-muted/30 text-sm">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{activeLocation.name}</span>
        </div>
      )}

      <input
        type="date"
        value={saleDate}
        onChange={posUser ? undefined : (e) => setSaleDate(e.target.value)}
        readOnly={!!posUser}
        className={`h-9 px-3 rounded-md border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring ${posUser ? "opacity-60 cursor-not-allowed" : ""}`}
        data-testid="input-sale-date"
      />

      {!isCreditSale && (
        <>
          <Select
            value={paymentAccountType}
            onValueChange={posUser ? undefined : (v: "bank" | "cash") => setPaymentAccountType(v)}
            disabled={!!posUser}
          >
            <SelectTrigger className="w-24" data-testid="select-account-type">
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
            disabled={!!posUser}
          >
            <SelectTrigger className="w-[180px]" data-testid="select-payment-account">
              <SelectValue placeholder={paymentAccountType === "bank" ? "Select Bank" : "Select Cash"} />
            </SelectTrigger>
            <SelectContent>
              {paymentAccountType === "bank"
                ? (Array.isArray(bankAccounts) ? bankAccounts : []).map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name} ({acc.code})
                    </SelectItem>
                  ))
                : cashLedgerAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        </>
      )}

      {!isSpCompany && (
        <div className="flex items-center gap-2">
          <Switch
            id="credit-sale-strip"
            checked={isCreditSale}
            onCheckedChange={setIsCreditSale}
            data-testid="toggle-credit-sale"
          />
          <Label htmlFor="credit-sale-strip" className="text-sm cursor-pointer">
            Credit
          </Label>
        </div>
      )}

      {!isSpCompany && isCreditSale && (
        <Popover open={customerComboOpen} onOpenChange={setCustomerComboOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="gap-2 font-normal" data-testid="select-customer">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="truncate max-w-[140px]">
                {selectedCustomerId
                  ? customerAccounts.find((a) => String(a.id) === selectedCustomerId)?.name || "Customer"
                  : "Select customer…"}
              </span>
              <ChevronDown className="h-4 w-4 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search customer…" data-testid="input-customer-search" />
              <CommandList>
                <CommandEmpty>No customer found.</CommandEmpty>
                <CommandGroup>
                  {customerAccounts.map((acc) => (
                    <CommandItem
                      key={acc.id}
                      value={acc.name ?? ""}
                      onSelect={() => {
                        setSelectedCustomerId(String(acc.id));
                        setCustomerComboOpen(false);
                      }}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 shrink-0 ${selectedCustomerId === String(acc.id) ? "opacity-100" : "opacity-0"}`}
                      />
                      {acc.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
