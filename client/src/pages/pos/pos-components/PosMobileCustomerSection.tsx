// Extracted from ./PosMobileLayout.tsx
import { MapPin, User, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { PosMobileLayoutProps } from "./PosMobileLayout";

export function PosMobileCustomerSection({
  posUser,
  lockedPosEdit,
  activeLocation,
  allLocations,
  setSelectedLocation,
  posAssignedLocations,
  posSelectedLocation,
  setPosSelectedLocation,
  saleDate,
  setSaleDate,
  isSpCompany,
  isCreditSale,
  setIsCreditSale,
  mobileCustomerComboOpen,
  setMobileCustomerComboOpen,
  selectedCustomerId,
  customerAccounts,
  setSelectedCustomerId,
  paymentAccountType,
  setPaymentAccountType,
  paymentAccountId,
  setPaymentAccountId,
  bankAccounts,
  cashLedgerAccounts,
}: {
  posUser: PosMobileLayoutProps["posUser"];
  lockedPosEdit: boolean;
  activeLocation: PosMobileLayoutProps["activeLocation"];
  allLocations: PosMobileLayoutProps["allLocations"];
  setSelectedLocation: PosMobileLayoutProps["setSelectedLocation"];
  posAssignedLocations: PosMobileLayoutProps["posAssignedLocations"];
  posSelectedLocation: PosMobileLayoutProps["posSelectedLocation"];
  setPosSelectedLocation: PosMobileLayoutProps["setPosSelectedLocation"];
  saleDate: PosMobileLayoutProps["saleDate"];
  setSaleDate: PosMobileLayoutProps["setSaleDate"];
  isSpCompany: PosMobileLayoutProps["isSpCompany"];
  isCreditSale: PosMobileLayoutProps["isCreditSale"];
  setIsCreditSale: PosMobileLayoutProps["setIsCreditSale"];
  mobileCustomerComboOpen: PosMobileLayoutProps["mobileCustomerComboOpen"];
  setMobileCustomerComboOpen: PosMobileLayoutProps["setMobileCustomerComboOpen"];
  selectedCustomerId: PosMobileLayoutProps["selectedCustomerId"];
  customerAccounts: PosMobileLayoutProps["customerAccounts"];
  setSelectedCustomerId: PosMobileLayoutProps["setSelectedCustomerId"];
  paymentAccountType: PosMobileLayoutProps["paymentAccountType"];
  setPaymentAccountType: PosMobileLayoutProps["setPaymentAccountType"];
  paymentAccountId: PosMobileLayoutProps["paymentAccountId"];
  setPaymentAccountId: PosMobileLayoutProps["setPaymentAccountId"];
  bankAccounts: PosMobileLayoutProps["bankAccounts"];
  cashLedgerAccounts: PosMobileLayoutProps["cashLedgerAccounts"];
}) {
  return (
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
            disabled={lockedPosEdit}
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
          className={`min-h-11 min-w-0 rounded-lg border border-input bg-background px-3 text-base font-mono outline-hidden focus:ring-2 focus:ring-ring ${
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
              disabled={lockedPosEdit}
              data-testid="toggle-mobile-credit-sale"
            />
          </div>
        )}

        {lockedPosEdit ? (
          <div
            className="flex min-h-11 items-center rounded-lg border bg-muted/30 px-3 text-sm"
            data-testid="pos-mobile-edit-payment-locked"
          >
            {isCreditSale ? "Credit" : "Original payment"} — unchanged
          </div>
        ) : !isSpCompany && isCreditSale ? (
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
                    ? customerAccounts.find((account) => String(account.id) === selectedCustomerId)?.name || "Customer"
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
          /* Full row from sm: in a half-width cell the account select shrank to ~90px on
               tablets and showed "Sele…" instead of the account name. */
          <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-2 sm:col-span-2">
            <Select
              value={paymentAccountType}
              onValueChange={
                posUser
                  ? undefined
                  : (value) => {
                      if (value === "bank" || value === "cash") setPaymentAccountType(value);
                    }
              }
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
  );
}
