import { ChevronDown, ScanLine, Search } from "lucide-react";
import { BaleWeightEditDialog } from "@/components/BaleWeightEditDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { BarcodeAdminDialogs } from "./BarcodeAdminDialogs";
import { BarcodeArticleResults } from "./BarcodeArticleResults";
import { BarcodeReferenceResults } from "./BarcodeReferenceResults";
import type { useBarcodeLookupModel } from "./useBarcodeLookupModel";

type BarcodeLookupModel = ReturnType<typeof useBarcodeLookupModel>;

export function BarcodeLookupView({ model }: { model: BarcodeLookupModel }) {
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-muted/20">
          <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-linear-to-br from-blue-500/30 to-blue-600/10 border border-blue-500/25 shrink-0">
            <ScanLine className="h-4.5 w-4.5 text-blue-500" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">Bale Lookup</h1>
            <p className="text-xs text-muted-foreground leading-tight">Search by reference number or article code</p>
          </div>
        </div>
        <div className="space-y-2.5 p-4">
          <div className="grid gap-2 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
            <button
              type="button"
              className="flex h-10 items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-xs font-medium text-foreground shadow-xs transition-colors hover:border-primary/50 hover:bg-muted/40"
              onClick={() => model.setSearchMode(model.searchMode === "reference" ? "article" : "reference")}
              data-testid="button-toggle-search-mode"
              title="Click to switch between Ref # and Article Code mode"
            >
              <span>{model.searchMode === "reference" ? "Ref #" : "Article"}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <Input
              placeholder="Scan or type a reference (REF…) or article code…"
              value={model.searchValue}
              onChange={(event) => model.setSearchValue(event.target.value)}
              onKeyDown={model.handleKeyDown}
              className="h-10 min-w-0"
              autoFocus
              data-testid="input-lookup-search"
            />
            <Button
              size="sm"
              onClick={model.handleSearch}
              disabled={model.isLoading || !model.searchValue.trim()}
              className="h-10 gap-1.5 px-4 sm:min-w-26"
              data-testid="button-lookup-search"
            >
              <Search className="h-4 w-4" />
              {model.isLoading ? "Searching…" : "Search"}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Mode auto-detects: inputs starting with <span className="font-mono font-medium">REF</span> search by
            reference number, everything else by article code. Use the selector to override.
          </p>
        </div>
      </div>

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
