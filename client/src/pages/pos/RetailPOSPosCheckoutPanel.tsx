// Extracted from ./RetailPOS.tsx
import { CalendarDays, MapPin, Wallet } from "lucide-react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { PosCheckoutField, PosCheckoutPanel } from "./pos-components/PosCheckoutPanel";
import { paymentAccountValue, paymentFromAccount, RetailPaymentAccountPicker } from "./RetailPaymentAccountSelect";
import { RetailCustomerPicker } from "./RetailCustomerPicker";
import { money, type RetailPaymentDraft } from "./retailPosTypes";
import { useRetailPOSState } from "./useRetailPOSState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function RetailPOSPosCheckoutPanel({
  creditAmount,
  customer,
  hasCreditTender,
  isPosRole,
  locations,
  paymentAccounts,
  payments,
  selectCustomer,
  selectedLocation,
  setPayments,
  setSelectedLocation,
  t,
}: Pick<
  ReturnType<typeof useRetailPOSState>,
  | "creditAmount"
  | "customer"
  | "hasCreditTender"
  | "isPosRole"
  | "locations"
  | "paymentAccounts"
  | "payments"
  | "selectCustomer"
  | "selectedLocation"
  | "setPayments"
  | "setSelectedLocation"
> &
  Pick<ReturnType<typeof useApplicationLanguage>, "t">) {
  return (
    <PosCheckoutPanel ariaLabel={t("pos.modern.saleSettings")}>
      <PosCheckoutField field="location" icon={MapPin} label={t("pos.modern.location")} htmlFor="retail-pos-location">
        <Select
          disabled={isPosRole}
          value={selectedLocation ? String(selectedLocation.id) : "__none__"}
          onValueChange={(v) => {
            const location = locations.find((entry) => entry.id === Number(v === "__none__" ? "" : v)) ?? null;
            setSelectedLocation(location);
          }}
        >
          <SelectTrigger id="retail-pos-location" className="h-9 min-w-[154px] max-w-[220px] text-sm">
            <SelectValue placeholder="Select location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Select location</SelectItem>
            {locations.map((location) => (
              <SelectItem key={location.id} value={String(location.id)}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PosCheckoutField>
      <PosCheckoutField field="date" icon={CalendarDays} label={t("pos.modern.date")} htmlFor="retail-pos-date">
        <input
          id="retail-pos-date"
          type="date"
          className="block h-9 w-full rounded-md border bg-muted/40 px-3 font-mono text-sm"
          value={new Date().toLocaleDateString("sv-SE")}
          readOnly
          aria-label="Sale date (set by server at checkout)"
          title="Retail sales use the actual checkout date; backdated posting is not enabled"
        />
      </PosCheckoutField>
      <PosCheckoutField field="account" icon={Wallet} label={t("pos.modern.account")} htmlFor="retail-pos-account">
        <RetailPaymentAccountPicker
          id="retail-pos-account"
          testId="retail-pos-account"
          className="block h-9 w-full rounded-md border bg-background px-3 text-sm"
          accounts={paymentAccounts}
          allowCredit={Boolean(customer?.id)}
          customerName={customer?.legalName}
          value={paymentAccountValue(payments[0] ?? { method: "cash", amount: 0 })}
          onValueChange={(selection) => {
            if (!paymentAccounts) return;
            setPayments((current) =>
              current.map((payment, index) =>
                index !== 0
                  ? payment
                  : selection
                    ? paymentFromAccount(selection, payment.amount, paymentAccounts)
                    : ({ method: "cash", amount: payment.amount, tenderedAmount: null } as RetailPaymentDraft)
              )
            );
          }}
        />/select>
      </PosCheckoutField>
      <div className="min-w-[190px] flex-1 xl:max-w-[350px]">
        <RetailCustomerPicker customer={customer} onSelect={selectCustomer} />
      </div>
      {hasCreditTender && (
        <span
          className="self-center text-xs font-medium text-amber-700 dark:text-amber-300"
          data-testid="retail-credit-amount"
        >
          {customer ? `On account: ${money(creditAmount)}` : "Choose a customer to post credit"}
        </span>
      )}
    </PosCheckoutPanel>
  );
}
