import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrencyContext, Currency } from "@/contexts/CurrencyContext";

interface ExchangeRateInputProps {
  value: number | null;
  onChange: (canonicalRate: number | null) => void;
  selectedCurrency: Currency;
  disabled?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function ExchangeRateInput({
  value,
  onChange,
  disabled = false,
  showLabel = true,
  className = "",
}: ExchangeRateInputProps) {
  const { exchangeRate: dailyRate } = useCurrencyContext();

  const [inputValue, setInputValue] = useState<string>("");
  const hasUserModified = useRef(false);
  const isInitialized = useRef(false);

  useEffect(() => {
    if (!isInitialized.current && !hasUserModified.current) {
      if (value !== null && value > 0) {
        setInputValue(value.toString());
        isInitialized.current = true;
      } else if (dailyRate && dailyRate > 0) {
        setInputValue(dailyRate.toString());
        onChange(dailyRate);
        isInitialized.current = true;
      }
    }
  }, [dailyRate, onChange, value]);

  useEffect(() => {
    if (value !== null && value > 0 && !hasUserModified.current) {
      setInputValue(value.toString());
    }
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setInputValue(raw);
    hasUserModified.current = true;

    if (raw === "" || raw === ".") {
      onChange(null);
      return;
    }

    const numValue = parseFloat(raw);
    if (isNaN(numValue) || numValue <= 0) {
      onChange(null);
      return;
    }

    onChange(numValue);
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showLabel && <Label className="text-xs text-muted-foreground whitespace-nowrap">1 USD =</Label>}
      <Input
        type="number"
        value={inputValue}
        onChange={handleInputChange}
        disabled={disabled}
        className="w-24 text-right"
        placeholder={dailyRate?.toString() || "Rate"}
        step="any"
        min="0"
        data-testid="input-exchange-rate"
      />
      {showLabel && <span className="text-xs text-muted-foreground">CFA</span>}
    </div>
  );
}
