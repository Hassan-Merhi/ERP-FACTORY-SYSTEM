import { Button } from "@/components/ui/button";
import { useCurrencyContext, type Currency } from "@/contexts/CurrencyContext";
import { cn } from "@/lib/utils";

interface CurrencySelectorProps {
  value?: Currency;
  onChange?: (currency: Currency) => void;
  className?: string;
}

/** Only currencies configured for the active company are selectable. */
export function CurrencySelector({ value, onChange, className }: CurrencySelectorProps) {
  const { selectedCurrency, setCurrency, baseCurrency, displayCurrency, isLoadingCompany } = useCurrencyContext();
  const options =
    displayCurrency && displayCurrency !== baseCurrency ? [baseCurrency, displayCurrency] : [baseCurrency];
  const currentValue = options.includes(value ?? selectedCurrency) ? (value ?? selectedCurrency) : baseCurrency;

  const handleChange = (currency: Currency) => {
    if (!options.includes(currency) || isLoadingCompany) return;
    if (onChange) onChange(currency);
    else setCurrency(currency);
  };

  return (
    <div className={cn("inline-flex rounded-md border", className)} data-testid="currency-selector">
      {options.map((currency, index) => (
        <Button
          key={currency}
          type="button"
          disabled={isLoadingCompany}
          variant={currentValue === currency ? "default" : "ghost"}
          size="sm"
          className={cn(index === 0 ? "rounded-r-none border-r" : "rounded-l-none")}
          onClick={() => handleChange(currency as Currency)}
          data-testid={`button-currency-${currency.toLowerCase()}`}
        >
          {currency}
        </Button>
      ))}
    </div>
  );
}
