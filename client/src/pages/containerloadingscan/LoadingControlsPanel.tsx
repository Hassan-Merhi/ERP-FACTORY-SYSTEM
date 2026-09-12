/**
 * Right column of the ERP container loading scan page. Linked proformas are
 * reusable references during live loading, so the comparison is informational
 * and never labels the current loading as overloaded/underloaded.
 */
import { CheckCircle, Info, MapPin, Play, Save, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ContainerLoadingScanModel } from "./useContainerLoadingScanModel";

function SetupCard({ model }: { model: ContainerLoadingScanModel }) {
  const { orderId, customerId, activeProforma, proformas } = model;
  return (
    <Card className="p-4 space-y-4">
      <div>
        <label className="text-sm font-medium mb-1 block">Customer</label>
        <Select value={model.selectedCustomerId} onValueChange={model.setSelectedCustomerId} disabled={!!orderId}>
          <SelectTrigger data-testid="select-customer">
            <SelectValue placeholder="Select customer..." />
          </SelectTrigger>
          <SelectContent>
            {model.customers.map((c) => (
              <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                {c.legalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="text-sm font-medium mb-1 block">
          <MapPin className="inline h-3 w-3 mr-1" />
          Loading Location
        </label>
        <Select value={model.selectedLocationId} onValueChange={model.setSelectedLocationId} disabled={!!orderId}>
          <SelectTrigger data-testid="select-location">
            <SelectValue placeholder="Select location..." />
          </SelectTrigger>
          <SelectContent>
            {model.locations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id.toString()} data-testid={`select-location-option-${loc.id}`}>
                {loc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {customerId && activeProforma && !orderId && (
        <div className="flex items-center gap-2">
          <Badge
            variant="default"
            className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
            data-testid="badge-active-proforma"
          >
            {activeProforma.name}
          </Badge>
          <span className="text-sm text-muted-foreground">Active proforma</span>
        </div>
      )}

      {customerId && !activeProforma && proformas.length === 0 && !orderId && (
        <p className="text-sm text-muted-foreground" data-testid="text-no-proforma">
          No active proforma found. Loading will proceed without price references.
        </p>
      )}

      <div>
        <label className="text-sm font-medium mb-1 block">
          <StickyNote className="inline h-3 w-3 mr-1" />
          Note
        </label>
        {!orderId ? (
          <Textarea
            placeholder="Optional note for this loading..."
            value={model.loadingNote}
            onChange={(e) => model.setLoadingNote(e.target.value)}
            className="resize-none text-sm"
            rows={2}
            data-testid="textarea-loading-note"
          />
        ) : (
          <div className="flex gap-2 items-start">
            <Textarea
              placeholder="Add a note..."
              value={model.loadingNote}
              onChange={(e) => model.setLoadingNote(e.target.value)}
              className="resize-none text-sm flex-1"
              rows={2}
              data-testid="textarea-loading-note"
            />
            <Button
              size="icon"
              variant="outline"
              onClick={() => model.saveNoteMutation.mutate(model.loadingNote)}
              disabled={model.saveNoteMutation.isPending}
              title="Save note"
              data-testid="button-save-note"
            >
              <Save className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {!orderId && (
        <Button
          className="w-full"
          onClick={model.handleStartLoading}
          disabled={
            !customerId ||
            !model.selectedLocationId ||
            model.createOrderMutation.isPending ||
            model.isProformaCapacityLoading
          }
          data-testid="button-start-loading"
        >
          <Play className="mr-2 h-4 w-4" />
          {model.createOrderMutation.isPending ? "Creating..." : "Start Loading"}
        </Button>
      )}
    </Card>
  );
}

function ProgressCard({ model }: { model: ContainerLoadingScanModel }) {
  const { linkedProforma, fulfilledCount, totalLines, proformaProgress, extraArticles, loadedByArticle } = model;
  const referenceOnly = proformaProgress.some((line) => line.status === "reference");
  const allFulfilled = !referenceOnly && fulfilledCount === totalLines && totalLines > 0;
  return (
    <Card className="p-4 flex flex-col gap-3" data-testid="card-proforma-progress">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="font-semibold text-sm">{linkedProforma!.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {referenceOnly
              ? "Reference only — this proforma does not cap this loading"
              : `${fulfilledCount} / ${totalLines} lines fulfilled`}
          </p>
        </div>
        <Badge
          variant={allFulfilled ? "default" : "secondary"}
          className={allFulfilled ? "bg-green-600 text-white no-default-hover-elevate no-default-active-elevate" : ""}
          data-testid="badge-proforma-progress"
        >
          {referenceOnly ? "Reference" : `${fulfilledCount}/${totalLines}`}
        </Badge>
      </div>

      <div className="overflow-y-auto max-h-[340px]">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="text-xs">Article</TableHead>
              <TableHead className="text-xs text-right">Proforma</TableHead>
              <TableHead className="text-xs text-right">Loaded Here</TableHead>
              <TableHead className="text-xs text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proformaProgress.map((line) => (
              <TableRow
                key={line.id}
                className={
                  line.status === "reference"
                    ? ""
                    : line.status === "fulfilled"
                      ? "bg-green-50 dark:bg-green-950/40"
                      : line.status === "overloaded"
                        ? "bg-orange-50 dark:bg-orange-950/30"
                        : ""
                }
                data-testid={`row-progress-${line.articleCode}`}
              >
                <TableCell className="text-xs font-mono py-1.5">
                  <div className="flex items-center gap-1">
                    {line.status === "fulfilled" && <CheckCircle className="h-3 w-3 text-green-600 shrink-0" />}
                    {line.status === "reference" && <Info className="h-3 w-3 text-muted-foreground shrink-0" />}
                    <span>{line.articleCode}</span>
                  </div>
                  <div className="text-muted-foreground truncate max-w-[100px]">{line.productName}</div>
                </TableCell>
                <TableCell className="text-xs text-right font-mono py-1.5">{line.quantity}</TableCell>
                <TableCell className="text-xs text-right font-mono py-1.5">{line.totalLoaded}</TableCell>
                <TableCell className="text-xs text-right py-1.5">
                  {line.status === "reference" ? (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
                      Reference
                    </Badge>
                  ) : line.status === "fulfilled" ? (
                    <span className="text-green-600 dark:text-green-400">✓</span>
                  ) : line.status === "overloaded" ? (
                    <span className="text-orange-600 dark:text-orange-400">+{line.excess}</span>
                  ) : line.status === "short" ? (
                    <span className="text-amber-600 dark:text-amber-400">{line.remaining}</span>
                  ) : (
                    <span className="text-muted-foreground">{line.quantity}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {extraArticles.map((code) => (
              <TableRow key={code} className="bg-muted/20" data-testid={`row-extra-${code}`}>
                <TableCell className="text-xs font-mono py-1.5">
                  <div>{code}</div>
                  <div className="text-muted-foreground text-[10px]">Outside proforma reference</div>
                </TableCell>
                <TableCell className="text-xs text-right py-1.5 text-muted-foreground">—</TableCell>
                <TableCell className="text-xs text-right font-mono py-1.5">{loadedByArticle[code]}</TableCell>
                <TableCell className="text-xs text-right py-1.5">
                  <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
                    Reference
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="border-t pt-2 text-xs text-muted-foreground flex items-center justify-between gap-2">
        <span>
          {model.bales.length} bales scanned · {model.totalWeight.toFixed(1)} kg
        </span>
      </div>
    </Card>
  );
}

function OrderSummaryCard({ model }: { model: ContainerLoadingScanModel }) {
  return (
    <Card className="p-4 space-y-2">
      <h3 className="font-semibold text-sm">Order Summary</h3>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Total Bales</span>
        <span className="font-mono" data-testid="text-total-bales">
          {model.bales.length}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Total Weight</span>
        <span className="font-mono" data-testid="text-total-weight">
          {model.totalWeight.toFixed(2)} kg
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Article Groups</span>
        <span className="font-mono" data-testid="text-article-groups">
          {Object.keys(model.groupedBalesMap).length}
        </span>
      </div>
    </Card>
  );
}

export function LoadingControlsPanel({ model }: { model: ContainerLoadingScanModel }) {
  const { orderId, linkedProforma } = model;
  return (
    <div className="lg:w-[40%] flex flex-col gap-4">
      <SetupCard model={model} />
      {orderId && linkedProforma ? <ProgressCard model={model} /> : orderId ? <OrderSummaryCard model={model} /> : null}

      {orderId && (
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => model.navigate("/factory/sales/loading/pending")}
            data-testid="button-save-exit"
          >
            <Save className="mr-2 h-4 w-4" />
            Save &amp; Exit
          </Button>
          <Button
            className="w-full"
            size="lg"
            onClick={() => model.setShowFinalizeDialog(true)}
            disabled={model.bales.length === 0 || model.finalizeMutation.isPending}
            data-testid="button-finalize-loading"
          >
            <CheckCircle className="mr-2 h-5 w-5" />
            Validate &amp; Finalize
          </Button>
        </div>
      )}
    </div>
  );
}
