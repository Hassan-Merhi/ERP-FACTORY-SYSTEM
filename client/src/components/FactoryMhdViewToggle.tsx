import { useState } from "react";
import { useLocation } from "wouter";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";

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
  const { t } = useApplicationLanguage();
  const mhd = useFactoryMhdView();
  const [error, setError] = useState("");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-sm" data-testid="factory-mhd-view-toggle">
      <span className="mr-1 font-medium">{t("mhd.viewLabel")}</span>
      {(["standard", "mhd"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={mhd.saving || (mode === "mhd" && (!mhd.hasMhdView || mhd.isLoading))}
          onClick={() => { setError(""); void mhd.setMode(mode).catch((cause) => setError(String(cause))); }}
          aria-pressed={mhd.mode === mode}
          className={`rounded-md border px-3 py-1.5 font-medium transition-colors disabled:opacity-50 ${mhd.mode === mode ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
        >
          {mode === "mhd" ? t("mhd.view") : t("mhd.standard")}
        </button>
      ))}
      {!mhd.hasMhdView && !mhd.isLoading && <span className="text-muted-foreground">{t("mhd.requireUpload")}</span>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  );
}

export function FactoryMhdViewToggle() {
  const [location] = useLocation();
  if (!affectedPaths.some((path) => location === path || location.startsWith(path + "/"))) return null;
  return <MhdToggleInner />;
}
