import { Button } from "@/components/ui/button";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { DollarSign } from "lucide-react";

/** Toggle the currently selected company's base/display currency pair. */
export function CurrencyToggle() {
  const { selectedCurrency, toggleCurrency, baseCurrency, displayCurrency, exchangeRate, hasExchangeRate } =
    useCurrencyContext();
  if (!displayCurrency || baseCurrency === displayCurrency) return null;

  const rateDescription =
    hasExchangeRate && exchangeRate
      ? `Rate: 1 ${baseCurrency} = ${exchangeRate.toLocaleString()} ${displayCurrency}`
      : `No ${baseCurrency}/${displayCurrency} exchange rate set in Company Settings`;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggleCurrency}
      className="font-mono text-xs"
      data-testid="button-currency-toggle"
      title={rateDescription}
      aria-label={`Currency: ${selectedCurrency}. Switch between ${baseCurrency} and ${displayCurrency}`}
    >
      <DollarSign className="h-3 w-3 mr-1" />
      {selectedCurrency}
    </Button>
  );
}
