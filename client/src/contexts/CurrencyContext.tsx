import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Company, UserPreferences } from "@shared/schema";
import type { Serialized } from "@shared/apiTypes";

/**
 * `/api/user-preferences` returns the saved row when one exists and a bare
 * `{ dateFormat }` default when it does not, so every other field is optional
 * on the wire even though the column is NOT NULL in the table.
 */
type UserPreferencesResponse = Partial<Serialized<UserPreferences>> & { dateFormat: string };

export type Currency = "USD" | "CFA";

interface CurrencyContextType {
  selectedCurrency: Currency;
  setCurrency: (currency: Currency) => void;
  toggleCurrency: () => void;
  exchangeRate: number | null;
  isLoadingRate: boolean;
  isLoadingCompany: boolean;
  baseCurrency: string;
  displayCurrency: string | null;
  isMultiCurrency: boolean;
  /** Converts USD → display currency and formats with symbol */
  formatAmount: (amount: number | string | null | undefined, currency?: Currency) => string;
  /** Formats amount as-is in the selected currency WITHOUT conversion.
   *  Use this for values already stored in the display currency (e.g. customer balances in CFA). */
  formatAmountRaw: (amount: number | string | null | undefined) => string;
  /** For amounts stored in CFA: shows CFA as-is, divides by rate to show USD.
   *  e.g. CFA 5,600,000 ÷ 551 = $10,162 when in USD mode. */
  formatCashAmount: (amount: number | string | null | undefined) => string;
  /**
   * Format an amount that is ALREADY in a specific transaction currency.
   * No conversion is applied — the amount is formatted with its own symbol.
   * Use for displaying transaction-currency amounts from voucher_entries.transactionDebitAmount etc.
   */
  formatTransactionAmount: (amount: number | string | null | undefined, currency: string) => string;
  /**
   * Format a historical base (USD) amount.
   * Always shows in USD regardless of the user's selected display currency.
   * Historical amounts must never be re-translated with the current rate.
   */
  formatHistoricalBaseAmount: (amount: number | string | null | undefined) => string;
  /**
   * Format a native (non-USD) cash/bank balance translated to the selected currency at the CURRENT rate.
   * Use for balance-sheet current-translation displays only — never for historical accounting.
   * @param nativeAmount  The stored native-currency amount (e.g. CFA balance).
   * @param nativeCurrency  The currency of that amount (e.g. "CFA").
   */
  formatCurrentCashTranslation: (nativeAmount: number | string | null | undefined, nativeCurrency: string) => string;
  /**
   * Format a new-transaction preview amount (uses the CURRENT company rate).
   * Use in transaction entry forms to show both currencies before posting.
   * @param amount  Amount in the selected (display) currency.
   */
  formatNewTransactionPreview: (amount: number | string | null | undefined) => string;
  convertToDisplay: (usdAmount: number) => number;
  convertToUSD: (displayAmount: number) => number;
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { selectedCompany } = useCompany();

  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(() => {
    const stored = localStorage.getItem("selectedCurrency");
    return stored === "USD" || stored === "CFA" ? stored : "USD";
  });

  // Fetch user preferences (includes preferredCurrency for logged-in users)
  const { data: userPrefs } = useQuery<UserPreferencesResponse>({
    queryKey: ["/api/user-preferences"],
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Mutation to save currency preference to backend
  const saveCurrencyMutation = useMutation({
    mutationFn: async (currency: Currency) => {
      await apiRequest("PUT", "/api/user-preferences", { preferredCurrency: currency });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-preferences"] });
    },
  });

  // Sync from backend preference on initial load (logged-in users)
  useEffect(() => {
    if (userPrefs?.preferredCurrency) {
      const backendCurrency = userPrefs.preferredCurrency as Currency;
      if (backendCurrency === "USD" || backendCurrency === "CFA") {
        setSelectedCurrency(backendCurrency);
        localStorage.setItem("selectedCurrency", backendCurrency);
      }
    }
  }, [userPrefs?.preferredCurrency]);

  // Fetch company details to get baseCurrency and displayCurrency
  const { data: company, isLoading: isLoadingCompanyQuery } = useQuery<Serialized<Company>>({
    queryKey: [`/api/companies/${selectedCompany?.id}`],
    enabled: !!selectedCompany?.id,
  });

  const isLoadingCompany = !selectedCompany?.id || isLoadingCompanyQuery || !company;

  const baseCurrency = company?.baseCurrency || "USD";
  const displayCurrency =
    company?.displayCurrency && company.displayCurrency !== "none" ? company.displayCurrency : null;
  const isMultiCurrency = !!displayCurrency;

  // Fetch the latest exchange rate using company's currencies
  const { data: rateData, isLoading: isLoadingRate } = useQuery({
    queryKey: ["/api/exchange-rates/latest", selectedCompany?.id, baseCurrency, displayCurrency],
    queryFn: async () => {
      if (!selectedCompany?.id || !displayCurrency || displayCurrency === "none") return null;
      const res = await fetch(
        `/api/exchange-rates/latest?companyId=${selectedCompany.id}&fromCurrency=${baseCurrency}&toCurrency=${displayCurrency}`,
        { credentials: "include" }
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedCompany?.id && !!displayCurrency,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const exchangeRate = rateData?.rate ? parseFloat(rateData.rate) : null;

  // Warn if multi-currency but no exchange rate
  useEffect(() => {
    if (isMultiCurrency && !isLoadingRate && !exchangeRate) {
      console.warn(
        "[Currency] Multi-currency company but no exchange rate found. Prices will display in base currency (USD). Set exchange rate in Settings."
      );
    }
  }, [isMultiCurrency, isLoadingRate, exchangeRate]);

  const setCurrency = (currency: Currency) => {
    setSelectedCurrency(currency);
    localStorage.setItem("selectedCurrency", currency);

    // Save to backend for logged-in users (fire and forget)
    saveCurrencyMutation.mutate(currency);
  };

  const toggleCurrency = () => {
    const newCurrency = selectedCurrency === "USD" ? "CFA" : "USD";
    setCurrency(newCurrency);
  };

  const convertToDisplay = (usdAmount: number): number => {
    if (!exchangeRate || selectedCurrency === "USD") return usdAmount;
    return usdAmount * exchangeRate;
  };

  const convertToUSD = (displayAmount: number): number => {
    if (!exchangeRate) return displayAmount;
    return displayAmount / exchangeRate;
  };

  // Shows the raw number as-is with the correct currency symbol — no USD→CFA conversion.
  // Use for amounts already stored in the display currency (e.g. customer balances).
  const formatAmountRaw = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return "";
    if (selectedCurrency === "CFA" && isMultiCurrency) {
      return `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
    const isWhole = Math.abs(numAmount) % 1 === 0;
    return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };

  // For cash/balance amounts. Behaviour depends on the company's base currency:
  //   baseCurrency=USD → amounts are in USD. USD mode: show as-is. CFA mode: multiply by rate.
  //   baseCurrency=CFA → amounts are in CFA. USD mode: divide by rate. CFA mode: show as-is.
  const formatCashAmount = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return "";

    if (baseCurrency === "USD") {
      // Amounts are already in USD — same behaviour as formatAmount
      if (selectedCurrency === "CFA" && exchangeRate) {
        const cfaAmount = numAmount * exchangeRate;
        return `CFA ${Math.round(cfaAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
      }
      const isWhole = Math.abs(numAmount) % 1 === 0;
      return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    }

    // baseCurrency=CFA: amounts stored in CFA
    if (selectedCurrency === "USD" && exchangeRate) {
      const usdAmount = numAmount / exchangeRate;
      const isWhole = Math.abs(usdAmount) % 1 === 0;
      return `$ ${usdAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    }
    // CFA mode (or no exchange rate) — show raw CFA
    return `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  // ─── New multi-currency formatters ──────────────────────────────────────────

  /**
   * Format an amount already in a specific transaction currency — no conversion.
   * Handles "CFA" and "USD" natively; falls back to generic formatting for others.
   */
  const formatTransactionAmount = (amount: number | string | null | undefined, currency: string): string => {
    if (amount === null || amount === undefined) return "";
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return "";
    const ccy = (currency || "USD").toUpperCase();
    if (ccy === "CFA" || ccy === "XOF") {
      return `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
    // USD or other — always 2 dp
    const isWhole = Math.abs(numAmount) % 1 === 0;
    return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };

  /**
   * Format a historical base (USD) amount.
   * Always displays in USD — historical values must never be re-translated.
   */
  const formatHistoricalBaseAmount = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return "";
    const isWhole = Math.abs(numAmount) % 1 === 0;
    return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };

  /**
   * Format a native-currency (e.g. CFA) cash/bank balance, translated to the selected
   * display currency using the CURRENT exchange rate.
   * For balance-sheet current-translation only — not for historical accounting figures.
   */
  const formatCurrentCashTranslation = (
    nativeAmount: number | string | null | undefined,
    nativeCurrency: string
  ): string => {
    if (nativeAmount === null || nativeAmount === undefined) return "";
    const numAmount = typeof nativeAmount === "string" ? parseFloat(nativeAmount) : nativeAmount;
    if (isNaN(numAmount)) return "";
    const ccy = (nativeCurrency || "USD").toUpperCase();
    const isCfa = ccy === "CFA" || ccy === "XOF";

    if (selectedCurrency === "CFA" && isCfa) {
      // Native CFA → show as CFA (no translation)
      return `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
    if (selectedCurrency === "USD" && isCfa && exchangeRate) {
      // CFA balance → USD at current rate (display-only, informational)
      const usdAmount = numAmount / exchangeRate;
      const isWhole = Math.abs(usdAmount) % 1 === 0;
      return `$ ${usdAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    }
    if (!isCfa) {
      // Already in USD or another non-CFA currency — show as-is
      const isWhole = Math.abs(numAmount) % 1 === 0;
      return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    }
    // Fallback: no exchange rate available
    return `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  /**
   * Preview a new transaction entry amount in the display currency, using the CURRENT rate.
   * Use in transaction entry forms to show both currencies before posting.
   * The amount is interpreted as being in the user's selected currency.
   */
  const formatNewTransactionPreview = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount) || numAmount === 0) return "";

    if (selectedCurrency === "USD") {
      // User typed USD — show USD, and optionally show CFA preview
      const isWhole = Math.abs(numAmount) % 1 === 0;
      const usdStr = `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
      if (isMultiCurrency && exchangeRate) {
        const cfaAmount = numAmount * exchangeRate;
        return `${usdStr} ≈ CFA ${Math.round(cfaAmount).toLocaleString()}`;
      }
      return usdStr;
    } else {
      // User typed CFA — show CFA, and show USD equivalent
      const cfaStr = `CFA ${Math.round(numAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
      if (exchangeRate) {
        const usdAmount = numAmount / exchangeRate;
        const isWhole = Math.abs(usdAmount) % 1 === 0;
        return `${cfaStr} ≈ $ ${usdAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
      }
      return cfaStr;
    }
  };

  const formatAmount = (amount: number | string | null | undefined, currency?: Currency): string => {
    if (amount === null || amount === undefined) return "";
    const curr = currency || selectedCurrency;
    const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(numAmount)) return "";

    // If requesting display currency format (CFA), first convert from USD
    let displayAmount = numAmount;
    if (curr === "CFA" && exchangeRate) {
      displayAmount = numAmount * exchangeRate;
    } else if (curr === "CFA" && !exchangeRate) {
      // No exchange rate available - show USD with warning
      console.warn("[Currency] No exchange rate available, displaying in USD");
      const isWhole = Math.abs(numAmount) % 1 === 0;
      return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    }

    if (curr === "USD") {
      const isWhole = Math.abs(numAmount) % 1 === 0;
      return `$ ${numAmount.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
    } else {
      return `CFA ${Math.round(displayAmount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
  };

  return (
    <CurrencyContext.Provider
      value={{
        selectedCurrency,
        setCurrency,
        toggleCurrency,
        exchangeRate,
        isLoadingRate,
        isLoadingCompany,
        baseCurrency,
        displayCurrency,
        isMultiCurrency,
        formatAmount,
        formatAmountRaw,
        formatCashAmount,
        formatTransactionAmount,
        formatHistoricalBaseAmount,
        formatCurrentCashTranslation,
        formatNewTransactionPreview,
        convertToDisplay,
        convertToUSD,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrencyContext() {
  const context = useContext(CurrencyContext);
  if (context === undefined) {
    throw new Error("useCurrencyContext must be used within a CurrencyProvider");
  }
  return context;
}
