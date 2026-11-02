import { ChevronDown, ScanLine, Search } from "lucide-react";
import { BaleWeightEditDialog } from "@/components/BaleWeightEditDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Skeleton } from "@/components/ui/skeleton";
import { BarcodeAdminDialogs } from "./BarcodeAdminDialogs";
import { BarcodeArticleResults } from "./BarcodeArticleResults";
import { BarcodeReferenceResults } from "./BarcodeReferenceResults";
import type { useBarcodeLookupModel } from "./useBarcodeLookupModel";

type BarcodeLookupModel = ReturnType<typeof useBarcodeLookupModel>;

export function BarcodeLookupView({ model }: { model: BarcodeLookupModel }) {
  return (
    <div className="space-y-5 px-3 py-4 sm:px-5 sm:py-5">
      <section
        className="relative isolate overflow-hidden rounded-2xl border border-blue-200/80 bg-linear-to-br from-white via-blue-50/75 to-indigo-50/80 shadow-[0_10px_32px_-20px_rgba(30,64,175,0.4)] dark:border-blue-500/30 dark:from-slate-950 dark:via-[#112448] dark:to-[#151d39] dark:shadow-[0_14px_44px_-23px_rgba(37,99,235,0.65)]"
        aria-labelledby="bale-lookup-heading"
      >
        <div className="pointer-events-none absolute -right-14 -top-20 h-64 w-64 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-500/20" aria-hidden="true" />
        <div className="pointer-events-none absolute bottom-0 right-24 h-24 w-56 rounded-full bg-violet-500/10 blur-3xl" aria-hidden="true" />
        <div className="relative flex items-center gap-3 border-b border-blue-200/70 px-4 py-4 sm:px-6 dark:border-blue-400/20">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-blue-400/30 bg-linear-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/20 dark:from-blue-500/35 dark:to-indigo-500/25 dark:text-blue-200">
            <ScanLine className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="bale-lookup-heading" className="text-lg font-bold tracking-tight text-slate-900 dark:text-white sm:text-xl">Bale Lookup</h2>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-blue-100/70 sm:text-sm">
              Search by reference number or article code
            </p>
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-full border border-blue-300/60 bg-blue-100/70 px-3 py-1.5 text-[11px] font-semibold text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200 sm:flex">
            <ScanLine className="h-3.5 w-3.5" aria-hidden="true" />
            Barcode Explorer
          </div>
        </div>
        <div className="relative space-y-3 p-4 sm:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
            <button
              type="button"
              className="flex h-12 w-full shrink-0 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/90 px-4 text-left text-sm font-semibold text-slate-900 shadow-sm transition-colors hover:border-blue-400 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-blue-300/25 dark:bg-slate-950/50 dark:text-slate-100 dark:hover:border-blue-400/70 dark:hover:bg-blue-950/50 md:w-36"
              onClick={() => model.setSearchMode(model.searchMode === "reference" ? "article" : "reference")}
              data-testid="button-toggle-search-mode"
              title="Click to switch between Ref # and Article Code mode"
            >
              <span>{model.searchMode === "reference" ? "Ref #" : "Article"}</span>
              <ChevronDown className="h-4 w-4 text-blue-600 dark:text-blue-300" />
            </button>
            <div className="flex min-w-0 flex-1 items-stretch gap-2">
              <Input
                placeholder="Scan or type a reference (REF…) or article code…"
                value={model.searchValue}
                onChange={(event) => model.setSearchValue(event.target.value)}
                onKeyDown={model.handleKeyDown}
                className="h-12 min-w-0 flex-1 rounded-xl border-blue-300/70 bg-white/90 px-4 text-sm shadow-sm focus-visible:ring-blue-500 dark:border-blue-400/40 dark:bg-slate-950/65 dark:text-white dark:placeholder:text-slate-400"
                autoFocus
                data-testid="input-lookup-search"
              />
              <MobileBarcodeScanner
                onScan={(code) => model.handleSearch(code)}
                disabled={model.isLoading}
                className="h-12 w-12 shrink-0 rounded-xl border border-blue-300/60 bg-blue-50 text-blue-700 dark:border-blue-400/30 dark:bg-slate-900 dark:text-blue-300"
              />
            </div>
            <Button
              size="sm"
              onClick={() => model.handleSearch()}
              disabled={model.isLoading || !model.searchValue.trim()}
              className="h-12 w-full gap-2 rounded-xl bg-linear-to-r from-blue-600 to-blue-700 px-6 text-sm font-bold text-white shadow-lg shadow-blue-600/20 hover:from-blue-500 hover:to-blue-600 md:w-36"
              data-testid="button-lookup-search"
            >
              <Search className="h-4 w-4" />
              {model.isLoading ? "Searching…" : "Search"}
            </Button>
          </div>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-blue-100/65">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold" aria-hidden="true">i</span>
            <span>
              Mode auto-detects: inputs starting with <span className="font-mono font-semibold">REF</span> search by
              reference number, everything else by article code. Use the selector to override.
            </span>
          </p>
        </div>
      </section>

      {model.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {model.articleResult && (
        <BarcodeArticleResults
          articleResult={model.articleResult}
          searchValue={model.searchValue}
          setSearchMode={model.setSearchMode}
          setSearchValue={model.setSearchValue}
          lookupReference={(referenceNumber) => model.referenceLookup.mutate(referenceNumber)}
          smartNum={model.smartNum}
        />
      )}

      {model.referenceResult && <BarcodeReferenceResults model={model} />}

      <BarcodeAdminDialogs model={model} />
      {model.AdminDialog}
      <BaleWeightEditDialog
        bale={model.weightEditBale}
        onClose={() => model.setWeightEditBale(null)}
        onSuccess={() => {
          model.setWeightEditBale(null);
          const referenceNumber = model.referenceResult?.labelPrint?.referenceNumber;
          if (referenceNumber) model.referenceLookup.mutate(referenceNumber);
        }}
      />
    </div>
  );
}
