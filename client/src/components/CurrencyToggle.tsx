import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { canSetDailyExchangeRate, openDailyRateEditor } from "@/lib/exchangeRateEditors";
import { DollarSign, Pencil } from "lucide-react";

/** Toggle the currently selected company's base/display currency pair. */
export function CurrencyToggle() {
  const { selectedCurrency, toggleCurrency, baseCurrency, displayCurrency, exchangeRate, hasExchangeRate } =
    useCurrencyContext();
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  if (!displayCurrency || baseCurrency === displayCurrency) return null;
  const canChangeRate = canSetDailyExchangeRate(currentUser?.role, currentUser?.posViewOnly);

  const rateDescription =
    hasExchangeRate && exchangeRate
      ? `Rate: 1 ${baseCurrency} = ${exchangeRate.toLocaleString()} ${displayCurrency}`
      : `No ${baseCurrency}/${displayCurrency} exchange rate set in Company Settings`;

  return (
    <>
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
      {canChangeRate && (
        <Button
          variant="outline"
          size="sm"
          onClick={openDailyRateEditor}
          className="font-mono text-xs"
          data-testid="button-change-daily-rate"
          title={`Change today's ${baseCurrency}/${displayCurrency} rate`}
          aria-label={`Change today's ${baseCurrency}/${displayCurrency} exchange rate`}
        >
          <Pencil className="h-3 w-3 mr-1" />
          {hasExchangeRate && exchangeRate ? exchangeRate.toLocaleString() : "Rate"}
        </Button>
      )}
    </>
  );
}
