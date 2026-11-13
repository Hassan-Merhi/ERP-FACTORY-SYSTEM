import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { getFinalizedSaleReturnCopy } from "@/i18n/factoryFinalizedSaleReturnTranslations";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { readFinalizedReturnImport } from "./finalizedSaleReturnImportFile";

type PreviewRow = {
  reference: string;
  status: "matched" | "duplicate" | "missing" | "ambiguous" | "blocked";
  message: string | null;
  baleId?: number;
  orderId?: number;
  invoiceNumber?: string;
  containerNumber?: string | null;
  customerName?: string | null;
  grandTotal?: string;
  articleCode?: string | null;
  productName?: string | null;
};
type Preview = { rows: PreviewRow[]; matched: number; issues: number; note: string };
type Posted = {
  invoiceNumber: string;
  quantity: number;
  customerCredit: string;
  revisedTotal: string;
  warning: string | null;
};
type InvoiceGroup = {
  orderId: number;
  invoiceNumber: string;
  containerNumber: string | null;
  customerName: string | null;
  grandTotal: string;
  rows: Array<PreviewRow & { baleId: number; orderId: number }>;
};
type Outcome = { success: boolean; quantity: number; message: string };

const endpoint = "/api/factory/finalized-sale-returns";
async function postJson<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Could not complete the return");
  return data as T;
}

export default function FinalizedSaleReturnImport() {
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const { toast } = useToast();
  const copy = getFinalizedSaleReturnCopy(language);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});

  useEffect(() => {
    setPreview(null);
    setSelectedOrders([]);
    setFileName("");
    setReason("");
    setConfirmed(false);
    setOutcomes({});
  }, [selectedCompany?.id]);

  const groups = useMemo(() => {
    const grouped = new Map<number, InvoiceGroup>();
    for (const row of preview?.rows ?? []) {
      if (row.status !== "matched" || row.orderId == null || row.baleId == null || !row.grandTotal) continue;
      const group = grouped.get(row.orderId) ?? {
        orderId: row.orderId,
        invoiceNumber: row.invoiceNumber || "",
        containerNumber: row.containerNumber || null,
        customerName: row.customerName || null,
        grandTotal: row.grandTotal,
        rows: [],
      };
      group.rows.push(row as PreviewRow & { baleId: number; orderId: number });
      grouped.set(row.orderId, group);
    }
    return [...grouped.values()];
  }, [preview]);

  const chosen = groups.filter((group) => selectedOrders.includes(group.orderId));
  const totalSelected = chosen.reduce((sum, group) => sum + group.rows.length, 0);
  const canPost =
    !!preview &&
    preview.issues === 0 &&
    totalSelected > 0 &&
    reason.trim().length >= 5 &&
    reason.trim().length <= 500 &&
    confirmed &&
    !posting &&
    !reading &&
    Object.keys(outcomes).length === 0;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || reading || posting) return;
    setReading(true);
    setPreview(null);
    setFileName(file.name);
    setSelectedOrders([]);
    setConfirmed(false);
    setOutcomes({});
    try {
      const references = await readFinalizedReturnImport(file);
      const mapped = await postJson<Preview>(endpoint + "/import-preview", { references });
      setPreview(mapped);
      setSelectedOrders([...new Set(mapped.rows.filter((r) => r.status === "matched").map((r) => r.orderId!))]);
    } catch (error) {
      toast({
        title: copy.importReadFailed,
        description: String(error instanceof Error ? error.message : error),
        variant: "destructive",
      });
    } finally {
      setReading(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Returns");
      worksheet.addRow(["Ref Code"]);
      worksheet.getColumn(1).width = 32;
      worksheet.getCell("A1").font = { bold: true };
      await writeFile(workbook, "Finalized_Sale_Return_References.xlsx");
    } catch (error) {
      toast({ title: copy.requestFailed, description: String(error), variant: "destructive" });
    }
  };

  const applyAll = async () => {
    if (!canPost) return;
    setPosting(true);
    let posted = 0;
    let failures = 0;
    for (const group of chosen) {
      let expectedTotal = group.grandTotal;
      let completed = 0;
      let warning = "";
      try {
        // The original secured route limits each write to 200 bale IDs.
        // A later chunk must use the new invoice total returned by the prior one.
        for (let offset = 0; offset < group.rows.length; offset += 200) {
          const batch = group.rows.slice(offset, offset + 200);
          const result = await postJson<Posted>(endpoint + "/apply", {
            orderId: group.orderId,
            baleIds: batch.map((row) => row.baleId),
            expectedTotal,
            reason: reason.trim(),
            confirmReturn: true,
          });
          completed += result.quantity;
          expectedTotal = result.revisedTotal;
          if (result.warning) warning = result.warning;
        }
        posted += completed;
        setOutcomes((previous) => ({
          ...previous,
          [group.orderId]: {
            success: true,
            quantity: completed,
            message: warning || copy.importPosted,
          },
        }));
      } catch (error) {
        failures += 1;
        setOutcomes((previous) => ({
          ...previous,
          [group.orderId]: {
            success: false,
            quantity: completed,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [endpoint + "/orders"] }),
      queryClient.invalidateQueries({ queryKey: [endpoint + "/history"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-balances"] }),
    ]);
    toast({
      title: failures ? copy.importPartial : copy.importPosted,
      description: String(posted) + " " + copy.bales + " · " + String(failures) + " " + copy.importFailedInvoices,
      variant: failures ? "destructive" : "default",
    });
    setPosting(false);
    setConfirmed(false);
  };

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="finalized-return-excel-import">
      <div>
        <h3 className="font-semibold">{copy.importTitle}</h3>
        <p className="text-sm text-muted-foreground">{copy.importDescription}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-2">
          <Label htmlFor="finalized-returns-excel">{copy.importFile}</Label>
          <Input
            id="finalized-returns-excel"
            type="file"
            accept=".xlsx,.csv"
            disabled={reading || posting}
            onChange={onFile}
          />
        </div>
        <Button type="button" variant="outline" disabled={reading || posting} onClick={downloadTemplate}>
          {copy.importTemplate}
        </Button>
      </div>
      {reading && (
        <p className="text-sm" role="status">
          {copy.importMapping}
        </p>
      )}
      {preview && (
        <div className="space-y-4" data-testid="finalized-return-import-preview">
          <p className="text-sm font-medium">
            {fileName} · {preview.matched} {copy.importMatches} · {preview.issues} {copy.importIssues}
          </p>
          {preview.issues > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {copy.importFixIssues}
            </p>
          )}
          <div className="max-h-72 overflow-auto rounded border">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="p-2">{copy.references}</th>
                  <th className="p-2">{copy.importStatus}</th>
                  <th className="p-2">{copy.dateInvoice}</th>
                  <th className="p-2">
                    {copy.name} / {copy.articleCode}
                  </th>
                  <th className="p-2">{copy.importDetails}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {preview.rows.map((row, index) => (
                  <tr key={row.reference + "-" + index}>
                    <td className="p-2 font-medium">{row.reference}</td>
                    <td className={"p-2 " + (row.status === "matched" ? "text-emerald-600" : "text-destructive")}>
                      {row.status}
                    </td>
                    <td className="p-2">
                      {row.invoiceNumber || "—"} {row.containerNumber ? " / " + row.containerNumber : ""}
                    </td>
                    <td className="p-2">
                      {row.productName || "—"} / {row.articleCode || "—"}
                    </td>
                    <td className="p-2">{row.message || row.customerName || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {groups.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-sm">{copy.importReviewInvoices}</p>
              {groups.map((group) => (
                <label key={group.orderId} className="flex flex-wrap items-center gap-2 rounded border p-3 text-sm">
                  <Checkbox
                    checked={selectedOrders.includes(group.orderId)}
                    disabled={posting || Object.keys(outcomes).length > 0 || preview.issues > 0}
                    onCheckedChange={(checked) =>
                      setSelectedOrders((current) =>
                        checked === true
                          ? [...new Set([...current, group.orderId])]
                          : current.filter((id) => id !== group.orderId)
                      )
                    }
                  />
                  <span className="font-semibold">{group.invoiceNumber}</span>
                  <span className="text-muted-foreground">
                    {group.containerNumber || copy.noContainer} · {group.customerName || copy.customer}
                  </span>
                  <span className="ml-auto font-medium">
                    {group.rows.length} {copy.bales}
                  </span>
                  {outcomes[group.orderId] && (
                    <span className={outcomes[group.orderId].success ? "text-emerald-600" : "text-destructive"}>
                      {outcomes[group.orderId].quantity} {copy.importPosted} · {outcomes[group.orderId].message}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground">{copy.importCaution}</p>
          <div className="space-y-2">
            <Label htmlFor="finalized-return-import-reason">{copy.reason}</Label>
            <Textarea
              id="finalized-return-import-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={posting || Object.keys(outcomes).length > 0}
              placeholder={copy.reasonPlaceholder}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              disabled={posting || Object.keys(outcomes).length > 0 || preview.issues > 0}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            {copy.importConfirm}
          </label>
          <Button type="button" onClick={applyAll} disabled={!canPost}>
            {posting ? copy.importPosting : copy.importApply + " (" + totalSelected + " " + copy.bales + ")"}
          </Button>
        </div>
      )}
    </section>
  );
}
