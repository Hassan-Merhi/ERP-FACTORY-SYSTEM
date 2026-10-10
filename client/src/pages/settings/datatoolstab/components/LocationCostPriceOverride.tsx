import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileDown, FileSpreadsheet, Loader2 } from "lucide-react";
import { getErrorDetails } from "@shared/errorUtils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppMode } from "@/contexts/AppModeContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";

export interface DataToolsLocationOption {
  id: number | string;
  name: string;
}

interface CostPriceSpreadsheetRow {
  barcode?: unknown;
  costPrice?: unknown;
}

interface CostPriceImportResponse {
  updated?: number;
}

interface LocationCostPriceOverrideProps {
  locations: DataToolsLocationOption[];
}

export function LocationCostPriceOverride({ locations }: LocationCostPriceOverrideProps) {
  const { toast } = useToast();
  const { t } = useApplicationLanguage();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [locationId, setLocationId] = useState("");
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Array<{ barcode: string; costPrice: number }>>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  const resetDialog = () => {
    setFile(null);
    setPreview([]);
    setErrors([]);
    setIsComplete(false);
  };

  const downloadTemplate = async () => {
    const template = [
      { barcode: "ITEM001", costPrice: "125.50" },
      { barcode: "ITEM002", costPrice: "95.75" },
    ];
    const ws = utils.json_to_sheet(template);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Cost Price Import");
    await writeFile(wb, "cost_price_import_template.xlsx");
    toast({
      title: t("settings.dataTools.costOverride.templateDownloaded"),
      description: t("settings.dataTools.costOverride.templateDownloadedDescription"),
    });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setErrors([]);
    setPreview([]);
    setIsComplete(false);
    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = utils.sheet_to_json<CostPriceSpreadsheetRow>(worksheet);
      if (rows.length === 0) {
        toast({
          title: t("settings.dataTools.costOverride.emptyFile"),
          description: t("settings.dataTools.costOverride.emptyFileDescription"),
          variant: "destructive",
        });
        return;
      }
      const headerRow = utils.sheet_to_json<string[]>(worksheet, { header: 1 })[0] || [];
      const columns = headerRow.map((header) => String(header || "").trim());
      const requiredColumns = ["barcode", "costPrice"];
      const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
      if (missingColumns.length > 0) {
        toast({
          title: t("settings.dataTools.costOverride.missingColumns"),
          description: t("settings.dataTools.costOverride.missingColumnsDescription"),
          variant: "destructive",
        });
        return;
      }
      const validationErrors: string[] = [];
      const validRows: Array<{ barcode: string; costPrice: number }> = [];
      rows.forEach((row, index) => {
        const rowNumber = index + 2;
        const barcode = String(row.barcode ?? "").trim();
        if (!barcode) {
          validationErrors.push(
            `${t("settings.dataTools.costOverride.row")} ${rowNumber}: ${t("settings.dataTools.costOverride.barcodeRequired")}`
          );
          return;
        }
        const numericCost =
          typeof row.costPrice === "number" ? row.costPrice : Number.parseFloat(String(row.costPrice ?? "0"));
        if (!Number.isFinite(numericCost) || numericCost <= 0) {
          validationErrors.push(
            `${t("settings.dataTools.costOverride.row")} ${rowNumber}: ${t("settings.dataTools.costOverride.costPositive")}`
          );
          return;
        }
        validRows.push({ barcode, costPrice: numericCost });
      });
      setPreview(validRows);
      setErrors(validationErrors);
    } catch {
      toast({
        title: t("settings.dataTools.costOverride.readError"),
        description: t("settings.dataTools.costOverride.readErrorDescription"),
        variant: "destructive",
      });
    }
  };

  const applyImport = async () => {
    if (!locationId) {
      toast({
        title: t("settings.dataTools.costOverride.noLocation"),
        description: t("settings.dataTools.costOverride.noLocationDescription"),
        variant: "destructive",
      });
      return;
    }
    if (errors.length > 0) {
      toast({
        title: t("settings.dataTools.costOverride.cannotImport"),
        description: t("settings.dataTools.costOverride.fixErrors"),
        variant: "destructive",
      });
      return;
    }
    setIsImporting(true);
    try {
      const response = await modeApiRequest("POST", `/api/locations/${locationId}/import-cost-prices`, {
        updates: preview,
      });
      const result = (await response.json()) as CostPriceImportResponse;
      queryClient.invalidateQueries({ queryKey: [`/api/locations/${locationId}/inventory`] });
      setIsComplete(true);
      toast({
        title: t("settings.dataTools.costOverride.importSuccessful"),
        description: `${t("settings.dataTools.costOverride.updatedPrefix")} ${result.updated ?? 0}.`,
      });
    } catch (error: unknown) {
      toast({
        title: t("settings.dataTools.costOverride.importFailed"),
        description: getErrorDetails(error).message || t("settings.dataTools.costOverride.importFailedDescription"),
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <Card className="group flex h-full flex-col overflow-hidden border-amber-500/30 bg-card/80 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500/50 hover:shadow-md">
        <CardHeader className="space-y-3 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <Badge
              variant="secondary"
              className="border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            >
              Developer
            </Badge>
          </div>
          <div className="space-y-1">
            <CardTitle className="text-base tracking-tight">{t("settings.dataTools.costOverride.title")}</CardTitle>
            <CardDescription className="text-sm leading-5">
              {t("settings.dataTools.costOverride.description")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="mt-auto space-y-4 pt-1">
          <div className="space-y-2">
            <Label>{t("settings.dataTools.costOverride.selectLocation")}</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger data-testid="select-location-cost-price-import">
                <SelectValue placeholder={t("settings.dataTools.costOverride.chooseLocation")} />
              </SelectTrigger>
              <SelectContent>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={String(location.id)}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            className="h-10 w-full"
            onClick={() => {
              resetDialog();
              setOpen(true);
            }}
            disabled={!locationId}
            data-testid="button-open-cost-price-import"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            {t("settings.dataTools.costOverride.openButton")}
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!isImporting) {
            if (!nextOpen) resetDialog();
            setOpen(nextOpen);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("settings.dataTools.costOverride.title")}</DialogTitle>
            <DialogDescription>{t("settings.dataTools.costOverride.dialogDescription")}</DialogDescription>
          </DialogHeader>
          {isComplete ? (
            <div className="space-y-4">
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription>{t("settings.dataTools.costOverride.success")}</AlertDescription>
              </Alert>
              <Button
                variant="outline"
                onClick={() => {
                  resetDialog();
                  setOpen(false);
                }}
                data-testid="button-cost-price-import-close"
              >
                {t("settings.dataTools.costOverride.close")}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Alert className="border-amber-500/40">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription>{t("settings.dataTools.costOverride.warning")}</AlertDescription>
              </Alert>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadTemplate}
                  data-testid="button-download-cost-price-template"
                >
                  <FileDown className="h-4 w-4 mr-1" />
                  {t("settings.dataTools.costOverride.downloadTemplate")}
                </Button>
                {file && <span className="text-sm text-muted-foreground truncate">{file.name}</span>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="cost-price-import-file">{t("settings.dataTools.costOverride.excelFile")}</Label>
                <Input
                  id="cost-price-import-file"
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                  data-testid="input-cost-price-import-file"
                />
                <p className="text-xs text-muted-foreground">{t("settings.dataTools.costOverride.fileHint")}</p>
              </div>
              {errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <ul className="list-disc pl-4 space-y-1">
                      {errors.map((error, index) => (
                        <li key={index}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {preview.length > 0 && (
                <div className="border rounded-md overflow-hidden">
                  <div className="max-h-[280px] overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("settings.dataTools.costOverride.barcode")}</TableHead>
                          <TableHead className="text-right">{t("settings.dataTools.costOverride.newCost")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.map((row, index) => (
                          <TableRow key={`${row.barcode}-${index}`}>
                            <TableCell className="font-mono">{row.barcode}</TableCell>
                            <TableCell className="text-right font-mono">{row.costPrice.toFixed(2)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="border-t px-3 py-2 text-xs text-muted-foreground">
                    {preview.length} {t("settings.dataTools.costOverride.updatesReady")}
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    resetDialog();
                    setOpen(false);
                  }}
                  disabled={isImporting}
                >
                  {t("settings.dataTools.costOverride.cancel")}
                </Button>
                <Button
                  onClick={applyImport}
                  disabled={isImporting || preview.length === 0 || errors.length > 0}
                  data-testid="button-apply-cost-price-import"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t("settings.dataTools.costOverride.updating")}
                    </>
                  ) : (
                    t("settings.dataTools.costOverride.apply")
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
