import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, type SpExcelImportContainer } from "@shared/spContainerExcelImport";

interface SpExcelParseResponse {
  fileName: string;
  rowCount: number;
  containers: SpExcelImportContainer[];
}

interface SpContainerExcelImportProps {
  /** Called with the chosen container once the sheet is parsed; fills the form. */
  onApply: (container: SpExcelImportContainer) => void;
}

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Upload of the ERP "PO Import" Excel into the Supplier Partner container form.
 *
 * The same file an ERP company imports for a container is parsed by the server
 * with the same reader, then recalculated into the Supplier Partner figures
 * (items total, charges, discount %, freight estimate and the Goods OTW total).
 * The user reviews the filled form and creates the container as usual.
 */
export function SpContainerExcelImport({ onApply }: SpContainerExcelImportProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<SpExcelParseResponse | null>(null);
  const [applied, setApplied] = useState<SpExcelImportContainer | null>(null);

  const apply = (container: SpExcelImportContainer) => {
    setApplied(container);
    onApply(container);
    toast({
      title: "Excel calculated for Supplier Partner",
      description: `${container.lines.length} line(s) · Goods OTW ${usd(container.invoiceTotalUsd)}. Review and create the container.`,
    });
  };

  const parseMutation = useMutation({
    mutationFn: async (file: File): Promise<SpExcelParseResponse> => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { message?: string; errors?: string[] };
        const detail = error.errors?.length ? `: ${error.errors.slice(0, 3).join("; ")}` : "";
        throw new Error(`${error.message || "Failed to read the Excel file"}${detail}`);
      }
      return (await response.json()) as SpExcelParseResponse;
    },
    onSuccess: (data) => {
      setParsed(data);
      setApplied(null);
      if (data.containers.length === 1) {
        apply(data.containers[0]);
      } else {
        toast({
          title: "Several containers in this file",
          description: `Found ${data.containers.length} containers. Choose the one to import.`,
        });
      }
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Excel import failed", description: error.message, variant: "destructive" });
    },
  });

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) parseMutation.mutate(file);
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Import from Excel</p>
            <p className="text-xs text-muted-foreground">
              Same PO Import file as the ERP. Totals, discount % and Goods OTW are calculated here for the Supplier
              Partner.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={parseMutation.isPending}
          data-testid="button-sp-upload-excel"
        >
          {parseMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5 mr-1" />
          )}
          {parsed ? "Upload another file" : "Upload Excel"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFile}
          data-testid="input-sp-excel-file"
        />
      </div>

      {parsed && parsed.containers.length > 1 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {parsed.fileName}: {parsed.containers.length} containers. Pick one to fill the form.
          </p>
          <Select
            value={applied?.containerNumber ?? ""}
            onValueChange={(containerNumber) => {
              const match = parsed.containers.find((c) => c.containerNumber === containerNumber);
              if (match) apply(match);
            }}
          >
            <SelectTrigger data-testid="select-sp-excel-container">
              <SelectValue placeholder="Choose container…" />
            </SelectTrigger>
            <SelectContent>
              {parsed.containers.map((c) => (
                <SelectItem key={c.containerNumber || "(blank)"} value={c.containerNumber}>
                  {c.containerNumber || "(no container number)"} · {c.itemsCount} items · {usd(c.grandTotal)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {applied && (
        <div className="space-y-2" data-testid="sp-excel-calculation">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{parsed?.fileName}</Badge>
            <Badge variant="outline">{applied.containerNumber || "no container #"}</Badge>
            {applied.poNumbers.length > 0 && <Badge variant="outline">PO {applied.poNumbers.join(", ")}</Badge>}
            <Badge variant="outline">{applied.lines.length} lines</Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Items total</span>
            <span className="text-right tabular-nums sm:col-span-2" data-testid="text-sp-excel-items-total">
              {usd(applied.itemsTotal)}
            </span>
            <span className="text-muted-foreground">Freight (estimate)</span>
            <span className="text-right tabular-nums sm:col-span-2">{usd(applied.charges.freight)}</span>
            {applied.charges.surcharge > 0 && (
              <>
                <span className="text-muted-foreground">Surcharge</span>
                <span className="text-right tabular-nums sm:col-span-2">{usd(applied.charges.surcharge)}</span>
              </>
            )}
            {applied.charges.fumigation > 0 && (
              <>
                <span className="text-muted-foreground">Fumigation</span>
                <span className="text-right tabular-nums sm:col-span-2">{usd(applied.charges.fumigation)}</span>
              </>
            )}
            {applied.charges.documentCharges > 0 && (
              <>
                <span className="text-muted-foreground">Document charges</span>
                <span className="text-right tabular-nums sm:col-span-2">{usd(applied.charges.documentCharges)}</span>
              </>
            )}
            {applied.charges.discount > 0 && (
              <>
                <span className="text-muted-foreground">Discount ({applied.discountPct}% of items)</span>
                <span className="text-right tabular-nums sm:col-span-2">−{usd(applied.charges.discount)}</span>
              </>
            )}
            <span className="font-medium">Grand total → Goods OTW</span>
            <span
              className="text-right tabular-nums font-semibold sm:col-span-2"
              data-testid="text-sp-excel-grand-total"
            >
              {usd(applied.invoiceTotalUsd)}
            </span>
          </div>

          {applied.supplierId === null && (
            <p className="text-xs text-amber-600" data-testid="text-sp-excel-supplier-missing">
              Supplier code “{applied.supplierCode || "blank"}” matched no supplier of this company. Select the supplier
              above.
            </p>
          )}
          {applied.unmatchedArticleCodes.length > 0 && (
            <p className="text-xs text-amber-600" data-testid="text-sp-excel-unmatched">
              {applied.unmatchedArticleCodes.length} article code(s) matched no stock item or alias:{" "}
              {applied.unmatchedArticleCodes.slice(0, 5).join(", ")}
              {applied.unmatchedArticleCodes.length > 5 ? "…" : ""}. The lines are kept by code; map them under{" "}
              <Link href="/sp/aliases" className="underline">
                Aliases
              </Link>{" "}
              before offloading.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
