import { Button } from "@/components/ui/button";
import { useCurrencyContext, Currency } from "@/contexts/CurrencyContext";
import { cn } from "@/lib/utils";

interface CurrencySelectorProps {
  value?: Currency;
  onChange?: (currency: Currency) => void;
  className?: string;
}

export function CurrencySelector({ value, onChange, className }: CurrencySelectorProps) {
  const { selectedCurrency, setCurrency } = useCurrencyContext();

  const currentValue = value !== undefined ? value : selectedCurrency;

  const handleChange = (currency: Currency) => {
    if (onChange) {
      onChange(currency);
    } else {
      setCurrency(currency);
    }
  };

  return (
    <div className={cn("inline-flex rounded-md border", className)} data-testid="currency-selector">
      <Button
        type="button"
        variant={currentValue === "USD" ? "default" : "ghost"}
        size="sm"
        className="rounded-r-none border-r"
        onClick={() => handleChange("USD")}
        data-testid="button-currency-usd"
      >
        USD
      </Button>
      <Button
        type="button"
        variant={currentValue === "CFA" ? "default" : "ghost"}
        size="sm"
        className="rounded-l-none"
        onClick={() => handleChange("CFA")}
        data-testid="button-currency-cfa"
      >
        CFA
      </Button>
    </div>
  );
}
