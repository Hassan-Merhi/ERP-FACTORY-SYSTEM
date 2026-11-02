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
    <div className="grid grid-cols-2 gap-2 rounded-2xl border border-border/70 bg-card/90 p-3 shadow-sm sm:flex sm:flex-wrap sm:items-center sm:gap-3">
      {/* Location */}
      <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
        <MapPin className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
        <Select value={model.locationId} onValueChange={model.setLocationId}>
          <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/60 sm:w-48" data-testid="select-location">
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
          className="h-10 w-full rounded-xl border-border/70 bg-background/60 sm:w-36"
          data-testid="input-sale-date"
        />
      </div>

      {/* Currency */}
      <div className="flex items-center gap-2">
        <Select value={model.currencyCode} onValueChange={model.setCurrencyCode}>
          <SelectTrigger className="h-10 w-24 rounded-xl border-border/70 bg-background/60 sm:w-28" data-testid="select-currency">
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
          <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/60 sm:w-48" data-testid="select-cash-account">
            <SelectValue placeholder="Cash account" />
          </SelectTrigger>
          <SelectContent>
            {model.cashAccounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
            {model.cashAccounts.length === 0 && (
              <div className="px-2 py-2 text-sm text-muted-foreground" role="status">
                {model.accountOptionsLoading
                  ? "Loading cash accounts…"
                  : model.accountOptionsError
                    ? "Unable to load cash accounts. Please refresh."
                    : "No active cash accounts for this company."}
              </div>
            )}
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
          className={`h-10 gap-1 rounded-xl ${model.paymentType === "CASH" ? "bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-600" : ""}`}
        >
          <Banknote className="h-3.5 w-3.5" />
          Cash
        </Button>
        <Button
          variant={model.paymentType === "CREDIT" ? "default" : "outline"}
          size="sm"
          onClick={() => model.setPaymentType("CREDIT")}
          data-testid="button-payment-type-credit"
          className={`h-10 gap-1 rounded-xl ${model.paymentType === "CREDIT" ? "bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-600" : ""}`}
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
            className="h-10 w-full rounded-xl border-border/70 bg-background/60 sm:w-44"
            data-testid="input-customer-name"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
          <User className="h-4 w-4 text-muted-foreground shrink-0 hidden sm:block" />
          <Select
            value={model.selectedCustomerId}
            onValueChange={(id) => {
              model.setSelectedCustomerId(id);
              // The sale, receipt and voucher carry the customer's name, not just its id.
              const customer = (model.allCustomers || []).find((c) => String(c.id) === id);
              if (customer) model.setCustomerName(customer.legalName || customer.name || "");
            }}
          >
            <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/60 sm:w-48" data-testid="select-credit-customer">
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

      {/* Keep notes reachable on mobile; desktop notes appear beside Products. */}
      <div className="col-span-2 flex items-center gap-2 md:hidden">
        <Textarea
          placeholder="Notes (optional)"
          value={model.notes}
          onChange={(e) => model.setNotes(e.target.value)}
          className="min-h-16 resize-none rounded-xl border-border/70 bg-background/60"
          aria-label="Notes (optional)"
          data-testid="input-notes-mobile"
        />
      </div>
    </div>
  );
}
