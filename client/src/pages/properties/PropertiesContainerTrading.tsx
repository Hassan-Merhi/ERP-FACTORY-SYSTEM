import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileSpreadsheet, ShieldCheck, Link2, Package } from "lucide-react";
import { usePropertiesContainerTradingState } from "./usePropertiesContainerTradingState";
const currency = (value: number | string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));

export default function PropertiesContainerTrading() {
  const {
    configure,
    copy,
    enabledPairs,
    externalSupplierId,
    file,
    importDate,
    importMutation,
    isLoading,
    preview,
    previewMutation,
    result,
    saveSelection,
    selectedPolicy,
    selections,
    setExternalSupplierId,
    setFile,
    setImportDate,
    setPreview,
    setResult,
    setTarget,
    setup,
    setupError,
    sourceId,
    target,
  } = usePropertiesContainerTradingState();

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10" data-testid="properties-container-trading">
      <PageHeader
        title="Container Trading"
        subtitle="Import Eurogulf and other supplier POs once in Properties, then create at-cost linked destination POs."
      />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
        <span>Each container belongs to one destination. No markup, cash payment or duplicate stock is created.</span>
      </div>
      {isLoading && <p>Loading authorized company relationships…</p>}
      {setupError && (
        <p role="alert" className="text-destructive">
          {(setupError as Error).message}
        </p>
      )}

      {setup && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-5 w-5" /> {copy.partnerSetup}
              </CardTitle>
              <CardDescription>{copy.partnerDescription}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ic-target">{copy.destinationCompany}</Label>
                  <select
                    id="ic-target"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">{copy.chooseCompany}</option>
                    {setup.destinations.map((company) => (
                      <option value={company.id} key={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>{copy.setupLabel}</Label>
                  <p className="flex h-10 items-center rounded-md border px-3 text-sm" data-testid="ic-setup-status">
                    {!target ? copy.chooseDestinationStatus : selectedPolicy ? copy.ready : copy.notConfigured}
                  </p>
                </div>
              </div>
              <Button
                onClick={() => configure.mutate()}
                disabled={!target || configure.isPending}
                data-testid="button-ic-configure"
              >
                {configure.isPending ? copy.settingUp : selectedPolicy ? copy.verifySetup : copy.enableTrading}
              </Button>
              <p className="text-xs text-muted-foreground">{copy.payableExplanation}</p>
              <p className="text-xs text-muted-foreground" data-testid="ic-enabled-pairs">
                {copy.readyDestinations}{" "}
                {enabledPairs.length
                  ? enabledPairs
                      .map(
                        (policy) =>
                          setup.destinations.find((company) => company.id === policy.destinationCompanyId)?.name
                      )
                      .join(", ")
                  : copy.none}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" /> Import supplier Excel
              </CardTitle>
              <CardDescription>
                Every physical container must be assigned to one active destination before confirming the entire
                workbook atomically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ic-excel">Original supplier workbook</Label>
                  <Input
                    id="ic-excel"
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      setPreview(null);
                      setResult(null);
                    }}
                    data-testid="input-ic-excel"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ic-supplier">Original external supplier</Label>
                  <select
                    id="ic-supplier"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={externalSupplierId}
                    onChange={(e) => setExternalSupplierId(e.target.value)}
                  >
                    <option value="">Choose supplier (e.g., Eurogulf)</option>
                    {setup.suppliers
                      .filter((s) => s.companyId === sourceId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.legalName}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ic-date">Import / posting date</Label>
                  <Input id="ic-date" type="date" value={importDate} onChange={(e) => setImportDate(e.target.value)} />
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => previewMutation.mutate()}
                disabled={!file || previewMutation.isPending}
                data-testid="button-ic-preview"
              >
                {previewMutation.isPending ? "Parsing…" : "Preview all containers"}
              </Button>
              {preview && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {preview.containers.length} container(s), {preview.rowCount} Excel rows. Charges are excluded from
                    the intercompany price unless you confirm them with evidence.
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Container / PO lines</TableHead>
                          <TableHead>Goods value</TableHead>
                          <TableHead>Sheet charges</TableHead>
                          <TableHead>Destination</TableHead>
                          <TableHead>Confirmed charges</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.containers.map((item) => {
                          const choice = selections[item.containerNumber];
                          return (
                            <TableRow key={item.containerNumber}>
                              <TableCell className="min-w-48">
                                <span className="font-medium">{item.containerNumber}</span>
                                <p className="text-xs text-muted-foreground">
                                  {item.itemsCount} line(s) / {item.posCount} original PO(s)
                                </p>
                              </TableCell>
                              <TableCell>{currency(item.itemsTotal)}</TableCell>
                              <TableCell>{currency(item.chargesTotal)}</TableCell>
                              <TableCell className="min-w-48">
                                <select
                                  aria-label={"Destination for " + item.containerNumber}
                                  className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
                                  value={choice?.relationshipId ?? ""}
                                  onChange={(e) =>
                                    saveSelection(item.containerNumber, "relationshipId", e.target.value)
                                  }
                                >
                                  <option value="">Choose destination</option>
                                  {enabledPairs.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {setup.destinations.find((c) => c.id === p.destinationCompanyId)?.name ??
                                        p.destinationCompanyId}
                                    </option>
                                  ))}
                                </select>
                              </TableCell>
                              <TableCell className="min-w-52">
                                <div className="flex items-center gap-2">
                                  <Checkbox
                                    id={"charge-" + item.containerNumber}
                                    checked={choice?.chargesConfirmed ?? false}
                                    onCheckedChange={(v) =>
                                      saveSelection(item.containerNumber, "chargesConfirmed", v === true)
                                    }
                                  />
                                  <Label htmlFor={"charge-" + item.containerNumber}>
                                    Confirmed, include in landed cost
                                  </Label>
                                </div>
                                {choice?.chargesConfirmed && item.chargesTotal !== 0 && (
                                  <Input
                                    className="mt-2"
                                    placeholder="Supplier invoice / freight document reference"
                                    value={choice.chargeEvidenceReference}
                                    onChange={(e) =>
                                      saveSelection(item.containerNumber, "chargeEvidenceReference", e.target.value)
                                    }
                                  />
                                )}
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Linked price:{" "}
                                  {currency(item.itemsTotal + (choice?.chargesConfirmed ? item.chargesTotal : 0))}
                                </p>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Phase 2 supports USD-base purchases only. Before confirmation, ensure that product codes and units
                    of measure exist in both companies. Existing offloading workflows are blocked for linked containers
                    until the Phase 5 inventory workflow is available.
                  </p>
                  <Button
                    onClick={() => importMutation.mutate()}
                    disabled={
                      importMutation.isPending ||
                      !externalSupplierId ||
                      preview.containers.some((c) => !selections[c.containerNumber]?.relationshipId)
                    }
                    data-testid="button-ic-import"
                  >
                    {importMutation.isPending ? "Posting linked POs…" : "Confirm entire workbook import"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {result && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="h-5 w-5" /> Linked purchase orders created
                </CardTitle>
                <CardDescription>
                  Batch {result.batchId} — {result.containerCount} containers; {currency(result.totalIntercompanyCost)}{" "}
                  at cost.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Original supplier PO IDs</TableHead>
                      <TableHead>Destination</TableHead>
                      <TableHead>Linked PO ID</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.containers.map((row) => (
                      <TableRow key={row.containerNumber}>
                        <TableCell>{row.containerNumber}</TableCell>
                        <TableCell>{row.sourcePoIds.join(", ")}</TableCell>
                        <TableCell>
                          {setup.destinations.find((c) => c.id === row.destinationCompanyId)?.name ??
                            row.destinationCompanyId}
                        </TableCell>
                        <TableCell>{row.destinationPoId}</TableCell>
                        <TableCell>{currency(row.landedTotal)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
