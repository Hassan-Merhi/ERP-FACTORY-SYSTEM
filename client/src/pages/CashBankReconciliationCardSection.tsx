// Extracted from ./CashBankReconciliation.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCashBankReconciliationState } from "./useCashBankReconciliationState";

export function CashBankReconciliationCardSection({
  busy,
  file,
  form,
  importMutation,
  preview,
  previewMutation,
  setFile,
  setForm,
  setPreview,
}: Pick<
  ReturnType<typeof useCashBankReconciliationState>,
  "busy" | "file" | "form" | "importMutation" | "preview" | "previewMutation" | "setFile" | "setForm" | "setPreview"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Import statement (CSV or Excel)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          File headers: Date, Amount (positive receipt / negative payment), Description, Reference, optional Balance. Or
          Date, Debit, Credit. Date format YYYY-MM-DD or DD/MM/YYYY. Maximum 5,000 lines.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Currency</Label>
            <Input
              maxLength={3}
              value={form.currency}
              onChange={(e) => {
                setForm((x) => ({ ...x, currency: e.target.value.toUpperCase() }));
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label>Period start</Label>
            <Input
              type="date"
              value={form.periodStart}
              onChange={(e) => {
                setForm((x) => ({ ...x, periodStart: e.target.value }));
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label>Period end</Label>
            <Input
              type="date"
              value={form.periodEnd}
              onChange={(e) => {
                setForm((x) => ({ ...x, periodEnd: e.target.value }));
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label>Statement opening balance</Label>
            <Input
              value={form.openingBalance}
              onChange={(e) => {
                setForm((x) => ({ ...x, openingBalance: e.target.value }));
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label>Statement closing balance</Label>
            <Input
              value={form.closingBalance}
              onChange={(e) => {
                setForm((x) => ({ ...x, closingBalance: e.target.value }));
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label>Statement file</Label>
            <Input
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !file} onClick={() => previewMutation.mutate()}>
            {previewMutation.isPending ? "Previewing…" : "Preview import"}
          </Button>
          <Button disabled={busy || !file || !preview?.balanced} onClick={() => importMutation.mutate()}>
            {importMutation.isPending ? "Importing…" : "Import balanced statement"}
          </Button>
        </div>
        {preview && (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <p>
              {preview.rowCount} transactions · Calculated closing: <strong>{preview.calculatedClosing}</strong> ·
              Stated closing: <strong>{preview.suppliedClosing}</strong>
            </p>
            <p className={preview.balanced ? "text-foreground" : "text-destructive"}>
              {preview.balanced
                ? "Amounts reconcile; safe to import as evidence."
                : "The imported movements do not equal the stated closing balance. Review the file before importing."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
