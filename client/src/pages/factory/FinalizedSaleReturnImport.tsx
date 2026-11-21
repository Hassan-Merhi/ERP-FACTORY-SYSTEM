import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFinalizedSaleReturnImportState } from "./useFinalizedSaleReturnImportState";

export default function FinalizedSaleReturnImport() {
  const {
    copy,
    setFileName,
    fileName,
    customerId,
    setCustomerId,
    exporting,
    customersLoading,
    customers,
    customersError,
    setPreview,
    preview,
    setSelectedOrders,
    selectedOrders,
    reason,
    setReason,
    setConfirmed,
    confirmed,
    reading,
    posting,
    setOutcomes,
    outcomes,
    groups,
    totalSelected,
    canPost,
    onFile,
    downloadPreview,
    downloadTemplate,
    applyAll,
  } = useFinalizedSaleReturnImportState();

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="finalized-return-excel-import">
      <div>
        <h3 className="font-semibold">{copy.importTitle}</h3>
        <p className="text-sm text-muted-foreground">{copy.importDescription}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="finalized-return-customer">{copy.importCustomerLabel}</Label>
        <Select
          value={customerId == null ? "__none__" : String(customerId)}
          disabled={reading || posting || customersLoading}
          onValueChange={(v) => {
            const next = v === "__none__" ? null : Number(v) || null;
            setCustomerId(next);
            setPreview(null);
            setSelectedOrders([]);
            setConfirmed(false);
            setOutcomes({});
            setFileName("");
          }}
        >
          <SelectTrigger
            id="finalized-return-customer"
            data-testid="finalized-return-customer"
            className="h-10 w-full max-w-lg"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">
              {customersLoading ? copy.importCustomerLoading : copy.importCustomerPlaceholder}
            </SelectItem>
            {customers.map((customer) => (
              <SelectItem key={customer.id} value={String(customer.id)}>
                {customer.legalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {customersError && (
          <p role="alert" className="text-sm text-destructive">
            {copy.importCustomerLoadFailed}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-2">
          <Label htmlFor="finalized-returns-excel">{copy.importFile}</Label>
          <Input
            id="finalized-returns-excel"
            type="file"
            accept=".xlsx,.csv"
            disabled={reading || posting || !customerId}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {preview.customerName} · {fileName} · {preview.matched} {copy.importMatches} · {preview.issues}{" "}
              {copy.importIssues}
            </p>
            <ExportButton
              kind="excel"
              variant="outline"
              label={exporting ? copy.importExporting : copy.importExportPreview}
              onClick={downloadPreview}
              disabled={exporting || posting}
            />
          </div>
          <p className="text-xs text-muted-foreground">{copy.importExportExplanation}</p>
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
                  <th className="p-2">{copy.importQuantity}</th>
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
                    <td className="p-2 font-mono">{row.status === "matched" ? 1 : 0}</td>
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
