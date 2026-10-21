/**
 * FX agent EUR wallet presentation for the Payment voucher: the wallet source
 * card that replaces the regular Pay From summary, and the payout section
 * (USD exchange or direct EUR supplier payment). Extracted from
 * PaymentReceiptTab.tsx; the parent owns all state and validation.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type FxWalletSummary = {
  wallet: { id: number; ledgerAccountId: number; accountName: string };
  state: { eur: string; usd: string; totalBookUsd: string };
  synchronized: boolean;
};

export function FxWalletSourceCard({
  accountName,
  eurAvailable,
  onChange,
}: {
  accountName: string;
  eurAvailable: string;
  onChange: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-1" data-testid="fx-payment-source">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">Pay from {accountName} (EUR wallet)</p>
        <Button type="button" variant="outline" size="sm" onClick={onChange}>
          Change
        </Button>
      </div>
      <p className="font-mono text-sm">
        EUR{" "}
        {Number(eurAvailable).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}{" "}
        available
      </p>
    </div>
  );
}

export function FxWalletPaymentSection({
  fxWallet,
  directEurPayment,
  showPayoutToggle,
  fxPayoutCurrency,
  fxPaymentRate,
  fxRateValue,
  fxEurRequired,
  fxSupplierEurBalance,
  fxSupplierEurBasis,
  fxSupplierBalanceLoading,
  fxUnsupportedEntries,
  total,
  onFxPaymentRateChange,
  onFxPayoutCurrencyChange,
}: {
  fxWallet: FxWalletSummary;
  directEurPayment: boolean;
  showPayoutToggle: boolean;
  fxPayoutCurrency?: "EUR" | "USD";
  fxPaymentRate?: string;
  fxRateValue: number;
  fxEurRequired: number;
  fxSupplierEurBalance: number | null;
  fxSupplierEurBasis?: "broker-statement" | "native-ledger" | null;
  fxSupplierBalanceLoading?: boolean;
  fxUnsupportedEntries: boolean;
  total: number;
  onFxPaymentRateChange?: (value: string) => void;
  onFxPayoutCurrencyChange?: (currency: "EUR" | "USD") => void;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-primary/30 bg-muted/20 p-4" data-testid="fx-payment-voucher">
      <div>
        <h4 className="text-sm font-semibold">
          {directEurPayment ? "Direct EUR supplier payment" : "FX agent payment — recipient gets USD"}
        </h4>
      </div>
      {showPayoutToggle && (
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant={directEurPayment ? "default" : "outline"}
            disabled={fxSupplierBalanceLoading || !fxSupplierEurBalance}
            onClick={() => onFxPayoutCurrencyChange?.("EUR")}
            data-testid="fx-pay-eur"
          >
            Pay EUR directly
          </Button>
          <Button
            type="button"
            size="sm"
            variant={!directEurPayment ? "default" : "outline"}
            onClick={() => onFxPayoutCurrencyChange?.("USD")}
            data-testid="fx-pay-usd"
          >
            Pay USD (exchange)
          </Button>
        </div>
      )}
      {fxSupplierBalanceLoading && <p className="text-sm text-muted-foreground">Loading supplier EUR balance…</p>}
      {fxSupplierEurBalance !== null && fxSupplierEurBalance > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="fx-supplier-eur-balance">
          {fxSupplierEurBasis === "broker-statement"
            ? "Broker EUR settlement balance (including OTW): "
            : "Supplier EUR payable: "}
          EUR {fxSupplierEurBalance.toFixed(2)}
        </p>
      )}
      {directEurPayment ? (
        <p className="text-sm" data-testid="fx-direct-eur-details">
          Enter the EUR amount below. Both the supplier's EUR payable and the agent's EUR wallet decrease by the same
          amount. No exchange rate needed.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium" htmlFor="fx-voucher-rate">
            Agreed payment rate — USD per 1 EUR
          </label>
          <Input
            id="fx-voucher-rate"
            type="number"
            min="0"
            step="any"
            placeholder="e.g. 1.14"
            value={fxPaymentRate}
            onChange={(event) => onFxPaymentRateChange?.(event.target.value)}
          />
        </>
      )}
      {total > 0 && (directEurPayment || fxRateValue > 0) && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Recipient receives</p>
            <p className="font-mono font-semibold">
              {fxPayoutCurrency} {total.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Agent EUR deduction</p>
            <p className="font-mono font-semibold">
              EUR{" "}
              {fxEurRequired.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6,
              })}
            </p>
          </div>
        </div>
      )}
      {!fxWallet.synchronized && (
        <p className="text-sm text-destructive">Ledger mismatch: reconcile the FX wallet before paying.</p>
      )}
      {fxEurRequired > Number(fxWallet.state.eur) && (
        <p className="text-sm text-destructive">Insufficient EUR held by this agent.</p>
      )}
      {directEurPayment && fxSupplierEurBalance !== null && total > fxSupplierEurBalance && (
        <p className="text-sm text-destructive">Amount exceeds supplier EUR balance.</p>
      )}
      {fxUnsupportedEntries && (
        <p className="text-sm text-destructive">
          Use one factory supplier or USD ledger recipient (not the FX agent itself) per payment.
        </p>
      )}
    </section>
  );
}
