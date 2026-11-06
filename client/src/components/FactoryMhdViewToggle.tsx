import { useState } from "react";
import { SlidersHorizontal, Info } from "lucide-react";
import { useLocation } from "wouter";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateApplicationText, type ApplicationTranslationKey } from "@/i18n/applicationTranslations";

const affectedPaths = [
  "/factory/stock-allocation-v5",
  "/factory/bales-hub",
  "/factory/bale-products",
  "/factory/sales/loading",
  "/factory/invoicing",
  "/factory/stock-bale-list",
  "/factory/bale-tracking",
  "/factory/bales-history",
  "/factory/bale-product-history",
  "/factory/price-list",
  "/factory/monthly-production-matrix",
  "/factory/location-inventory",
  "/factory/stock-query",
];

function MhdToggleInner() {
  const t =
    useOptionalApplicationLanguage()?.t ?? ((key: ApplicationTranslationKey) => translateApplicationText(key, "en"));
  const mhd = useFactoryMhdView();
  const [error, setError] = useState("");
  const needsUpload = !mhd.isLoading && !mhd.hasMhdView;

  return (
    <div className="mb-2 flex flex-col items-end gap-1" data-testid="factory-mhd-view-toggle">
      <div
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-card/90 p-1 shadow-sm dark:border-white/10 dark:bg-card/80"
        role="group"
        aria-label={t("mhd.viewLabel")}
      >
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground" title={t("mhd.viewLabel")}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        {(["standard", "mhd"] as const).map((mode) => {
          const active = mhd.mode === mode;
          const disabled = mhd.saving || (mode === "mhd" && (!mhd.hasMhdView || mhd.isLoading));
          return (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              title={mode === "mhd" && needsUpload ? t("mhd.requireUpload") : undefined}
              onClick={() => {
                setError("");
                void mhd.setMode(mode).catch((cause) => setError(String(cause)));
              }}
              className={`inline-flex h-7 items-center justify-center whitespace-nowrap rounded-full px-3 text-xs font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-primary text-primary-foreground shadow-[0_2px_7px_-2px_hsl(var(--primary)/0.45)]"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {mode === "mhd" ? t("mhd.view") : t("mhd.standard")}
            </button>
          );
        })}
        {needsUpload && (
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75"
            title={t("mhd.requireUpload")}
            aria-label={t("mhd.requireUpload")}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </div>
      {error && (
        <span role="alert" className="max-w-72 text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

export function FactoryMhdViewToggle() {
  const [location] = useLocation();
  if (!affectedPaths.some((path) => location === path || location.startsWith(path + "/"))) return null;
  return <MhdToggleInner />;
}
