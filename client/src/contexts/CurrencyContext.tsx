import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import {
  allowedCompanyCurrency,
  currencyPreferenceScope,
  legacyCfaCurrencyPreference,
  readScopedCurrencyPreference,
  saveLegacyCfaCurrencyPreference,
  saveScopedCurrencyPreference,
} from "@/lib/currencyPreference";
import {
  isSupportedAccountingCurrency,
  normalizeAccountingCurrencyAlias,
  type SupportedAccountingCurrency,
} from "@shared/currencyCatalog";
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

export type Currency = SupportedAccountingCurrency;

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
  /** False when a non-USD configured currency has no valid company-specific rate. */
  hasExchangeRate: boolean;
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
  const { data: authenticatedUser } = useQuery(authenticatedUserQueryOptions());
  const { data: userPrefs } = useQuery<UserPreferencesResponse>({
    queryKey: ["/api/user-preferences"],
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // The saved user preference in the legacy API is *global*. Read/write it
  // only for an existing CFA company to preserve Mali behavior. Other company
  // choices are stored per authenticated user and per company in the browser.
  const saveLegacyCfaPreference = useMutation({
    mutationFn: async (currency: Currency) => {
      await apiRequest("PUT", "/api/user-preferences", { preferredCurrency: currency });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-preferences"] });
    },
  });

  const companyId = selectedCompany?.id ?? null;
  const { data: company, isLoading: isLoadingCompanyQuery } = useQuery<Serialized<Company>>({
    queryKey: ["/api/companies/" + companyId],
    enabled: !!companyId,
  });
  const isLoadingCompany = !companyId || isLoadingCompanyQuery || !company;
  const baseCurrency = normalizeAccountingCurrencyAlias(company?.baseCurrency || "USD");
  const configuredDisplay =
    company?.displayCurrency && company.displayCurrency !== "none"
      ? normalizeAccountingCurrencyAlias(company.displayCurrency)
      : null;
  const displayCurrency = configuredDisplay && configuredDisplay !== baseCurrency ? configuredDisplay : null;
  const isMultiCurrency = !!displayCurrency;
  const companyCurrency = (value: string): value is Currency => isSupportedAccountingCurrency(value);
  const defaultCurrency: Currency =
    displayCurrency === "USD" && baseCurrency !== "USD" ? "USD" : companyCurrency(baseCurrency) ? baseCurrency : "USD";

  const authenticatedId = authenticatedUser?.id;
  const scope =
    companyId && authenticatedId !== undefined && authenticatedId !== null
      ? currencyPreferenceScope(companyId, String(authenticatedId))
      : null;
  const [choice, setChoice] = useState<{ scope: string; currency: Currency } | null>(null);
  const activeChoiceScope = scope ?? (companyId ? "unpersisted-company:" + companyId : null);

  const allowed = (value: string | null | undefined): value is Currency =>
    !!value && companyCurrency(value) && allowedCompanyCurrency(value, baseCurrency, displayCurrency);

  // Resolving this value from the CURRENT scope means even the first render
  // following a company switch cannot display the old company's currency.
  const savedChoice = readScopedCurrencyPreference(scope);
  const legacyPreference =
    displayCurrency === "CFA" || baseCurrency === "CFA"
      ? legacyCfaCurrencyPreference(userPrefs?.preferredCurrency)
      : null;
  const selectedCurrency: Currency =
    activeChoiceScope && choice?.scope === activeChoiceScope && allowed(choice.currency)
      ? choice.currency
      : allowed(savedChoice)
        ? savedChoice
        : allowed(legacyPreference)
          ? legacyPreference
          : defaultCurrency;

  // A change in another browser tab updates this tab without changing the
  // active company or cross-loading stale preferences into the next company.
  const [storageRevision, setStorageRevision] = useState(0);
  useEffect(() => {
    if (!scope) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === scope) {
        setChoice((previous) => (previous?.scope === scope ? null : previous));
        setStorageRevision((n) => n + 1);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [scope]);
  // storageRevision ensures a re-render on a same-scope cross-tab update.
  void storageRevision;

  const { data: rateData, isLoading: isLoadingRate } = useQuery<{ rate: string | number } | null>({
    queryKey: ["/api/exchange-rates/latest", companyId, baseCurrency, displayCurrency],
    queryFn: async () => {
      if (!companyId || !displayCurrency) return null;
      const params = new URLSearchParams({
        companyId: String(companyId),
        fromCurrency: baseCurrency,
        toCurrency: displayCurrency,
      });
      const res = await fetch("/api/exchange-rates/latest?" + params.toString(), { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!companyId && !!displayCurrency && !isLoadingCompany,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
  const parsedRate = Number(rateData?.rate);
  const exchangeRate = displayCurrency && rateData && Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null;
  const hasExchangeRate = !displayCurrency || exchangeRate !== null;

  useEffect(() => {
    if (displayCurrency && !isLoadingCompany && !isLoadingRate && !hasExchangeRate) {
      console.warn(
        "[Currency] Missing company rate for " +
          baseCurrency +
          "/" +
          displayCurrency +
          "; ZMW transactions cannot be converted."
      );
    }
  }, [displayCurrency, baseCurrency, isLoadingCompany, isLoadingRate, hasExchangeRate]);

  const setCurrency = (currency: Currency) => {
    if (isLoadingCompany || !allowed(currency)) return;
    if (activeChoiceScope) setChoice({ scope: activeChoiceScope, currency });
    if (scope) saveScopedCurrencyPreference(scope, currency);
    // Keep the original CFA-only global preference behavior (legacy browser
    // key and backend preference); ZMW never writes a global preference that
    // could overwrite Mali's selection.
    if ((displayCurrency === "CFA" || baseCurrency === "CFA") && (currency === "USD" || currency === "CFA")) {
      saveLegacyCfaCurrencyPreference(currency);
      saveLegacyCfaPreference.mutate(currency);
    }
  };

  const toggleCurrency = () => {
    if (!displayCurrency) return;
    setCurrency(selectedCurrency === baseCurrency ? (displayCurrency as Currency) : (baseCurrency as Currency));
  };

  // Keep original USD text spacing and zero-decimal CFA presentation. ZMW
  // always uses two decimal places (ngwee): K250.00.
  const native = (amount: number | string | null | undefined, currency: string): string => {
    if (amount === null || amount === undefined || amount === "") return "";
    const number = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(number)) return "";
    const code = normalizeAccountingCurrencyAlias(currency);
    if (code === "USD") {
      const whole = Math.abs(number) % 1 === 0;
      return (
        "$ " + number.toLocaleString(undefined, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })
      );
    }
    if (code === "CFA") return "CFA " + Math.round(number).toLocaleString(undefined, { maximumFractionDigits: 0 });
    return formatMoneyDisplay(number, { currency: code });
  };

  const convertToDisplay = (usdAmount: number): number => {
    if (selectedCurrency === "USD") return usdAmount;
    if (exchangeRate && selectedCurrency === displayCurrency) return usdAmount * exchangeRate;
    if (baseCurrency === "CFA" && displayCurrency === "USD" && selectedCurrency === "CFA" && exchangeRate) {
      return usdAmount * exchangeRate;
    }
    // Preserve the existing Mali numerical display fallback; for Zambia an
    // unresolved conversion is invalid rather than an invented ZMW amount.
    return selectedCurrency === "CFA" ? usdAmount : Number.NaN;
  };

  // Unchanged contract: an amount in the company's foreign currency divided by
  // the pair rate whenever one exists (Mali callers rely on this regardless of
  // the toggle). Without a rate, CFA keeps its legacy pass-through; a Kwacha
  // amount is never silently treated as USD.
  const convertToUSD = (amount: number): number => {
    if (exchangeRate) return amount / exchangeRate;
    return displayCurrency === "ZMW" ? Number.NaN : amount;
  };

  const formatAmountRaw = (amount: number | string | null | undefined): string => native(amount, selectedCurrency);

  const formatTransactionAmount = (amount: number | string | null | undefined, currency: string): string =>
    native(amount, currency);

  const formatHistoricalBaseAmount = (amount: number | string | null | undefined): string => native(amount, "USD");

  const formatAmount = (amount: number | string | null | undefined, currency?: Currency): string => {
    if (amount === null || amount === undefined) return "";
    const value = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(value)) return "";
    const destination = currency ?? selectedCurrency;
    if (destination === "USD") return native(value, "USD");
    if (destination === displayCurrency && exchangeRate) {
      return native(value * exchangeRate, destination);
    }
    if (baseCurrency === "CFA" && displayCurrency === "USD" && destination === "CFA" && exchangeRate) {
      return native(value * exchangeRate, "CFA");
    }
    // Missing rate: display the original USD amount instead of a fabricated
    // number with a foreign currency prefix. Existing Mali behavior retained.
    return native(value, "USD");
  };

  const formatCashAmount = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const value = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(value)) return "";
    if (selectedCurrency === baseCurrency) return native(value, baseCurrency);
    if (!exchangeRate || !displayCurrency) return native(value, baseCurrency);
    if (baseCurrency === "USD") return native(value * exchangeRate, displayCurrency);
    // Backward compatibility: historic non-USD-base companies stored their
    // foreign-per-USD rate, so displaying USD uses division, not multiplication.
    if (displayCurrency === "USD") return native(value / exchangeRate, "USD");
    return native(value * exchangeRate, displayCurrency);
  };

  const formatCurrentCashTranslation = (
    nativeAmount: number | string | null | undefined,
    nativeCurrency: string
  ): string => {
    if (nativeAmount === null || nativeAmount === undefined) return "";
    const value = typeof nativeAmount === "number" ? nativeAmount : Number(nativeAmount);
    if (!Number.isFinite(value)) return "";
    const source = normalizeAccountingCurrencyAlias(nativeCurrency || baseCurrency);
    if (selectedCurrency === source) return native(value, source);
    if (baseCurrency === "USD" && displayCurrency && exchangeRate) {
      if (source === displayCurrency && selectedCurrency === "USD") return native(value / exchangeRate, "USD");
      if (source === "USD" && selectedCurrency === displayCurrency)
        return native(value * exchangeRate, displayCurrency);
    }
    if (
      baseCurrency === "CFA" &&
      displayCurrency === "USD" &&
      source === "CFA" &&
      selectedCurrency === "USD" &&
      exchangeRate
    ) {
      return native(value / exchangeRate, "USD");
    }
    // An unrelated native currency or missing rate cannot be automatically
    // translated using the USD/ZMW company pair. Show native money honestly.
    return native(value, source);
  };

  const formatNewTransactionPreview = (amount: number | string | null | undefined): string => {
    if (amount === null || amount === undefined) return "";
    const value = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(value) || value === 0) return "";
    const entry = native(value, selectedCurrency);
    if (!displayCurrency) return entry;
    if (!exchangeRate) return entry + " (exchange rate unavailable)";
    if (baseCurrency === "CFA" && displayCurrency === "USD") {
      if (selectedCurrency === "USD") return entry + " ≈ " + native(value * exchangeRate, "CFA");
      if (selectedCurrency === "CFA") return entry + " ≈ " + native(value / exchangeRate, "USD");
    }
    if (selectedCurrency === baseCurrency) return entry + " ≈ " + native(value * exchangeRate, displayCurrency);
    if (selectedCurrency === displayCurrency) return entry + " ≈ " + native(value / exchangeRate, baseCurrency);
    return entry;
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
        hasExchangeRate,
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
