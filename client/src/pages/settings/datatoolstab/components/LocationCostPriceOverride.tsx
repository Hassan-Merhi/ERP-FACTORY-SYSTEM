import { AlertTriangle, CheckCircle2, FileDown, FileSpreadsheet, Loader2 } from "lucide-react";
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
import { useLocationCostPriceOverrideState } from "./useLocationCostPriceOverrideState";

export interface DataToolsLocationOption {
  id: number | string;
  name: string;
}

interface LocationCostPriceOverrideProps {
  locations: DataToolsLocationOption[];
}

export function LocationCostPriceOverride({ locations }: LocationCostPriceOverrideProps) {
  const {
    t,
    locationId,
    setLocationId,
    setOpen,
    open,
    file,
    preview,
    errors,
    isImporting,
    isComplete,
    resetDialog,
    downloadTemplate,
    handleFileChange,
    applyImport,
  } = useLocationCostPriceOverrideState();

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
