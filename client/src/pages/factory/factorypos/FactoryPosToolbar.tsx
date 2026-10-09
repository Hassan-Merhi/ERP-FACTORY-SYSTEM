/**
 * Factory POS toolbar: location, date, currency, cash account, the
 * cash/credit payment toggle, customer and notes.
 *
 * Split out of FactoryPOS.tsx unchanged — switching to CASH still clears the
 * selected credit customer, and the customer control still swaps between a
 * free-text name (cash) and a required customer select (credit).
 */
import { Banknote, CreditCard, MapPin, User, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FactoryPosModel } from "./useFactoryPosModel";

const CURRENCIES = ["USD", "EUR", "GBP", "LBP"];

export function FactoryPosToolbar({ model }: { model: FactoryPosModel }) {
  return (
    <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-4">
      {/* Location */}
      <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
        <MapPin className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
        <Select value={model.locationId} onValueChange={model.setLocationId}>
          <SelectTrigger className="w-full sm:w-48" data-testid="select-location">
            <SelectValue placeholder="Select location" />
          </SelectTrigger>
          <SelectContent>
            {(model.locations || []).map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Date */}
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={model.txDate}
          onChange={(e) => model.setTxDate(e.target.value)}
          className="w-full sm:w-36"
          data-testid="input-sale-date"
        />
      </div>

      {/* Currency */}
      <div className="flex items-center gap-2">
        <Select value={model.currencyCode} onValueChange={model.setCurrencyCode}>
          <SelectTrigger className="w-24 sm:w-28" data-testid="select-currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cash Account */}
      <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
        <Wallet className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
        <Select value={model.cashAccountId} onValueChange={model.setCashAccountId}>
          <SelectTrigger className="w-full sm:w-48" data-testid="select-cash-account">
            <SelectValue placeholder="Cash account" />
          </SelectTrigger>
          <SelectContent>
            {model.cashAccounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Payment Type Toggle */}
      <div className="flex items-center gap-1 col-span-2 sm:col-span-1">
        <Button
          variant={model.paymentType === "CASH" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            model.setPaymentType("CASH");
            model.setSelectedCustomerId("");
          }}
          data-testid="button-payment-type-cash"
          className="gap-1"
        >
          <Banknote className="h-3.5 w-3.5" />
          Cash
        </Button>
        <Button
          variant={model.paymentType === "CREDIT" ? "default" : "outline"}
          size="sm"
          onClick={() => model.setPaymentType("CREDIT")}
          data-testid="button-payment-type-credit"
          className="gap-1"
        >
          <CreditCard className="h-3.5 w-3.5" />
          Credit
        </Button>
      </div>

      {/* Customer — always visible for cash, required for credit */}
      {model.paymentType === "CASH" ? (
        <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
          <User className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
          <Input
            placeholder="Customer name (optional)"
            value={model.customerName}
            onChange={(e) => model.setCustomerName(e.target.value)}
            className="w-full sm:w-44"
            data-testid="input-customer-name"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
          <User className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
          <Select value={model.selectedCustomerId} onValueChange={model.setSelectedCustomerId}>
            <SelectTrigger className="w-full sm:w-48" data-testid="select-credit-customer">
              <SelectValue placeholder="Select customer *" />
            </SelectTrigger>
            <SelectContent>
              {(model.allCustomers || []).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.legalName || c.name || `Customer #${c.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Notes */}
      <div className="col-span-2 sm:col-span-1 sm:flex-1 flex items-center gap-2 order-last sm:order-none">
        <Textarea
          placeholder="Notes (optional)"
          value={model.notes}
          onChange={(e) => model.setNotes(e.target.value)}
          className="resize-none h-9"
          data-testid="input-notes"
        />
      </div>
    </div>
  );
}
