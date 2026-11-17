import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/contexts/CompanyContext";

import { useToast } from "@/hooks/use-toast";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateApplicationText, type ApplicationTranslationKey } from "@/i18n/applicationTranslations";
import { Download, FileUp, Loader2, Save } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { exportFileName } from "@/lib/exportFile";

type InputRow = { articleCode: string; itemName: string };
type Product = { id: number; articleCode: string; name: string };
type MhdData = {
  revision: number;
  rows: Array<InputRow & { sortOrder: number }>;
  updatedAt: string;
  products: Product[];
  canEdit: boolean;
  history: Array<{ revision: number; rows: Array<InputRow & { sortOrder: number }>; updatedAt: string }>;
};
const normalize = (value: string) => value.trim().toUpperCase();

async function mhdRequest(url: string, options?: RequestInit): Promise<MhdData> {
  const response = await fetch(url, { credentials: "include", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "MHD View request failed");
  return payload as MhdData;
}

export function MhdViewManager() {
  const t =
    useOptionalApplicationLanguage()?.t ?? ((key: ApplicationTranslationKey) => translateApplicationText(key, "en"));
  const { selectedCompany } = useCompany();
  const client = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<InputRow[] | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const queryKey = ["/api/factory/mhd-view", selectedCompany?.id];
  useEffect(() => {
    setPreview(null);
    setIssues([]);
  }, [selectedCompany?.id]);
  const { data, isLoading, error } = useQuery<MhdData>({
    queryKey,
    enabled: Boolean(selectedCompany?.id),
    queryFn: () => mhdRequest("/api/factory/mhd-view"),
    staleTime: 30_000,
  });

  const downloadTemplate = async (withProducts: boolean) => {
    try {
      const { default: ExcelJS } = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("MHD View");
      worksheet.columns = [
        { header: "Article Code", key: "articleCode", width: 28 },
        { header: "Item Name", key: "itemName", width: 50 },
      ];
      worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C2541" } };
      worksheet.getColumn(1).numFmt = "@";
      if (withProducts && data) {
        const existing = new Map(data.rows.map((row) => [normalize(row.articleCode), row.itemName]));
        const savedOrder = new Map(data.rows.map((row) => [normalize(row.articleCode), row.sortOrder]));
        const productsInMhdOrder = [...data.products].sort(
          (a, b) =>
            (savedOrder.get(normalize(a.articleCode)) ?? Number.MAX_SAFE_INTEGER) -
              (savedOrder.get(normalize(b.articleCode)) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)
        );
        for (const product of productsInMhdOrder) {
          worksheet.addRow([product.articleCode, existing.get(normalize(product.articleCode)) || ""]);
        }
      }
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      const { writeFile } = await import("@/lib/excelHelper");
      await writeFile(
        workbook,
        withProducts ? exportFileName("factory mhd products", "xlsx") : "factory-mhd-template.xlsx"
      );
    } catch (cause) {
      toast({ title: t("mhd.downloadFailed"), description: String(cause), variant: "destructive" });
    }
  };

  const onExcel = async (file: File | undefined) => {
    setIssues([]);
    setPreview(null);
    if (!file) return;
    setBusy(true);
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
        throw new Error(t("mhd.fileLimit"));
      }
      const { readFile } = await import("@/lib/excelHelper");
      const workbook = await readFile(file);
      const worksheet = workbook.worksheets[0];
      if (
        !worksheet ||
        normalize(worksheet.getCell("A1").text) !== "ARTICLE CODE" ||
        normalize(worksheet.getCell("B1").text) !== "ITEM NAME" ||
        worksheet.columnCount > 2
      ) {
        throw new Error(t("mhd.invalidColumns"));
      }
      const parsed: InputRow[] = [];
      const errors: string[] = [];
      const known = new Set((data?.products || []).map((product) => normalize(product.articleCode)));
      const seen = new Set<string>();
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const code = row.getCell(1).text.trim();
        const itemName = row.getCell(2).text.trim();
        if (!code && !itemName) return;
        if (!code) errors.push(`Row ${rowNumber}: Article Code is required.`);
        else if (seen.has(normalize(code))) errors.push(`Row ${rowNumber}: Duplicate Article Code ${code}.`);
        else if (!known.has(normalize(code))) errors.push(`Row ${rowNumber}: Unknown Article Code ${code}.`);
        else if (itemName.length > 250) errors.push(`Row ${rowNumber}: Item Name is too long.`);
        seen.add(normalize(code));
        parsed.push({ articleCode: code, itemName });
      });
      if (!parsed.length) errors.push(t("mhd.noProductRows"));
      if (parsed.length > 10000) errors.push(t("mhd.maxProducts"));
      setIssues(errors.slice(0, 50));
      setPreview(parsed);
    } catch (cause) {
      setIssues([cause instanceof Error ? cause.message : t("mhd.parseFailed")]);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const publish = async () => {
    if (!data || !preview || !preview.length || issues.length) return;
    setBusy(true);
    try {
      await mhdRequest("/api/factory/mhd-view", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview, expectedRevision: data.revision }),
      });
      setPreview(null);
      await client.invalidateQueries({ queryKey });
      toast({ title: t("mhd.published"), description: t("mhd.publishedDescription") });
    } catch (cause) {
      toast({
        title: t("mhd.publishFailed"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="factory-mhd-manager">
      <CardHeader>
        <CardTitle>{t("mhd.managerTitle")}</CardTitle>
        <CardDescription>{t("mhd.managerDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{String(error)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void downloadTemplate(false)}
            disabled={isLoading || busy}
          >
            <Download className="mr-2 h-4 w-4" />
            {t("mhd.downloadTemplate")}
          </Button>
          <ExportButton
            kind="excel"
            variant="outline"
            label={t("mhd.downloadCurrent")}
            onClick={() => void downloadTemplate(true)}
            disabled={!data || busy}
          />
          {data?.canEdit && (
            <>
              <Button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
                <FileUp className="mr-2 h-4 w-4" />
                {t("mhd.uploadExcel")}
              </Button>
              <Input
                ref={fileRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(event) => void onExcel(event.target.files?.[0])}
                data-testid="input-mhd-view-excel"
              />
            </>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("mhd.savedRevision")} {data?.revision ?? 0} · {data?.rows.length ?? 0} {t("mhd.sortedProducts")}
          {data?.updatedAt ? " · " + t("mhd.lastPublished") + " " + new Date(data.updatedAt).toLocaleString() : ""}
        </p>
        {issues.length > 0 && (
          <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
            {issues.map((issue, index) => (
              <p key={index}>{issue}</p>
            ))}
            <p className="mt-2">{t("mhd.correctFile")}</p>
          </div>
        )}
        {!preview && data?.canEdit && Boolean(data.history?.length) && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const previous = data.history[data.history.length - 1];
              setIssues([]);
              setPreview(previous.rows.map((row) => ({ articleCode: row.articleCode, itemName: row.itemName })));
            }}
          >
            {t("mhd.restorePrevious")}
          </Button>
        )}
        {preview && (
          <div className="space-y-3">
            <p className="font-semibold">
              {t("mhd.uploadPreview")} · {preview.length} {t("mhd.rows")} · {issues.length} {t("mhd.errors")}
            </p>
            <div className="max-h-72 overflow-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-muted">
                    <th className="p-2">{t("mhd.order")}</th>
                    <th className="p-2">{t("mhd.articleCode")}</th>
                    <th className="p-2">{t("mhd.nameOptional")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 250).map((row, index) => (
                    <tr key={index} className="border-t">
                      <td className="p-2">{index + 1}</td>
                      <td className="p-2 font-mono">{row.articleCode}</td>
                      <td className="p-2">
                        {row.itemName ||
                          data?.products.find(
                            (product) => normalize(product.articleCode) === normalize(row.articleCode)
                          )?.name ||
                          t("mhd.originalName")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.length > 250 && <p className="text-xs text-muted-foreground">{t("mhd.previewLimit")}</p>}
            <Button type="button" onClick={() => void publish()} disabled={busy || issues.length > 0 || !data?.canEdit}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {t("mhd.publish")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
