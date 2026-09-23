/**
 * Setup card of the container loading scan page: customer, loading location,
 * proforma, note and the Start Loading action.
 */
import { FileText, MapPin, Play, Save, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

export function LoadingSetupCard({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, customerId, activeProformas } = model;

  return (
    <div className="overflow-hidden rounded-2xl border bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3 sm:px-5">
        <h3 className="text-sm font-semibold sm:text-base">{model.tr("loadingDetails")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {orderId ? model.tr("loadingDetailsLockedHint") : model.tr("loadingDetailsSetupHint")}
        </p>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <UserRound className="h-3.5 w-3.5" />
            {model.tr("customer")}
          </label>
          <Select value={model.selectedCustomerId} onValueChange={model.setSelectedCustomerId} disabled={!!orderId}>
            <SelectTrigger className="h-10 rounded-xl bg-muted/10" data-testid="select-customer">
              <SelectValue placeholder={model.tr("selectCustomer")} />
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
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            {model.tr("loadingLocation")}
          </label>
          <Select value={model.selectedLocationId} onValueChange={model.setSelectedLocationId} disabled={!!orderId}>
            <SelectTrigger className="h-10 rounded-xl bg-muted/10" data-testid="select-location">
              <SelectValue placeholder={model.tr("selectLocation")} />
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

        {customerId && !orderId && activeProformas.length > 0 && (
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              {model.tr("proforma")}
            </label>
            <Select value={model.selectedProformaId} onValueChange={model.setSelectedProformaId}>
              <SelectTrigger className="h-10 rounded-xl bg-muted/10" data-testid="select-proforma">
                <SelectValue placeholder={model.tr("selectProforma")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="select-proforma-none">
                  {model.tr("noProforma")}
                </SelectItem>
                {activeProformas.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)} data-testid={`select-proforma-option-${p.id}`}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {customerId && !orderId && activeProformas.length === 0 && (
          <div
            className="rounded-xl border border-dashed bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground"
            data-testid="text-no-proforma"
          >
            {model.tr("noActiveProforma")}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{model.tr("note")}</label>
          {orderId ? (
            <div className="flex items-start gap-2">
              <Textarea
                value={model.loadingNote}
                onChange={(e) => model.setLoadingNote(e.target.value)}
                placeholder={model.tr("addLoadingNote")}
                className="min-h-[78px] resize-none rounded-xl bg-muted/10 text-sm"
                rows={2}
                data-testid="input-loading-note"
              />
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0 rounded-xl"
                onClick={() => model.saveNoteMutation.mutate(model.loadingNote)}
                disabled={model.saveNoteMutation.isPending}
                data-testid="button-save-note"
                title={model.tr("saveNote")}
              >
                <Save className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Textarea
              value={model.loadingNote}
              onChange={(e) => model.setLoadingNote(e.target.value)}
              placeholder={model.tr("optionalNote")}
              className="min-h-[78px] resize-none rounded-xl bg-muted/10 text-sm"
              rows={2}
              data-testid="input-loading-note"
            />
          )}
        </div>

        {!orderId && (
          <Button
            className="h-11 w-full rounded-xl"
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
            {model.createOrderMutation.isPending ? model.tr("creating") : model.tr("startLoading")}
          </Button>
        )}
      </div>
    </div>
  );
}
